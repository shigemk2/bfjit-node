var ref = require("ref");
var ffi = require("ffi");

var os   = process.platform;
var arch = process.arch;
if (arch != "ia32" && arch != "x64") {
  console.log("unknown arch: " + arch);
  process.exit(1);
}

var jitalloc = (function() {
  var kernel32 = ffi.Library("kernel32", {
    "VirtualAlloc": ["pointer", ["pointer", "size_t", "int", "int"]],
    "VirtualFree": ["bool", ["pointer", "int", "int"]],
  });

  var MEM_COMMIT  = 0x1000;
  var MEM_RELEASE = 0x8000;
  var PAGE_EXECUTE_READWRITE = 0x40;

  return function(size) {
    var p = kernel32.VirtualAlloc(ref.NULL, size,
                                  MEM_COMMIT, PAGE_EXECUTE_READWRITE);
    var ret = p.reinterpret(size);
    ret.free = function() {
      kernel32.VirtualFree(p, 0, MEM_RELEASE);
    };
    return ret;
  };
})();

// 32ビットの数字をリトルエンディアンに変換する
function conv32(x) {
   return String.fromCharCode( x        & 0xff) +
          String.fromCharCode((x >>  8) & 0xff) +
          String.fromCharCode((x >> 16) & 0xff) +
          String.fromCharCode((x >> 24) & 0xff);
}

function main(src) {

  var codes = "";
  var begin = [];
  codes += "\x53";                         // push ebx|rbx
  codes += "\x8b\x5c\x24\x08";           // mov ebx, [esp+8]

  for (var pc = 0; pc < src.length; pc++) {
    switch (src[pc]) {
    case "+":
      codes += "\xfe\x03";                 // inc byte ptr[ebx|rbx]
      break;
    case "-":
      codes += "\xfe\x0b";                 // dec byte ptr[ebx|rbx]
      break;
    case ">":
      codes += "\x43";                   // inc ebx
      break;
    case "<":
      codes += "\x4b";                   // dec ebx
      break;
    case "[":
      begin.push(codes.length);
      codes += "\x80\x3b\x00";             // cmp byte ptr[ebx|rbx], 0
      codes += "\x0f\x84\x00\x00\x00\x00"; // jz near ????
      break;
    case "]":
      var ad1 = begin.pop();
      var ad2 = codes.length + 5;
      codes = codes.substring(0, ad1 + 5) +
              conv32(ad2 - (ad1 + 9)) +
              codes.substring(ad1 + 9);
      codes += "\xe9" + conv32(ad1 - ad2); // jmp near begin
      break;
    case ".":
      codes += "\x0f\xb6\x03";           // movzx eax, byte ptr[ebx]
      codes += "\x50";                   // push eax
      codes += "\xff\x54\x24\x10";       // call [esp+16]
      codes += "\x83\xc4\x04";           // add esp, 4
      break;
    case ",":
      codes += "\xff\x54\x24\x10";       // call [esp+16]
      codes += "\x88\x03";                 // mov bytr ptr[ebx|rbx], al
      break;
    }
  }
  codes += "\x5b";                         // pop ebx|rbx
  codes += "\xc3";                         // ret

  var buf = jitalloc(codes.length);
  buf.binaryWrite(codes, 0);

  var func = ffi.ForeignFunction(buf, "void", ["pointer", "pointer", "pointer"]);
  var mem = new Buffer(30000);
  mem.fill(0, 0, 30000);

  var libcName = "msvcrt";
  var dl = new ffi.DynamicLibrary(libcName, ffi.RTLD_NOW);
  var getchar = dl.get("getchar");
  var putchar = dl.get("putchar");
  func(mem, putchar, getchar);

  buf.free();
}

if (process.argv.length < 2) {
  console.log('missing argument.');
  return;
}

var fs = require('fs');
fs.readFile(process.argv[2], 'utf8', function (err, src) {
  main(src);
});

