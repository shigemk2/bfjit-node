var ref = require("ref");
var ffi = require("ffi");

var os   = process.platform;
var arch = process.arch;
if (arch != "ia32" && arch != "x64") {
  console.log("unknown arch: " + arch);
  process.exit(1);
}

var jitalloc = (function() {
  if (os == "win32") {
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
  } else {
    var libc = ffi.Library("libc", {
      "mmap": ["pointer", ["pointer", "size_t", "int", "int", "int", "int64"]],
      "munmap": ["int", ["pointer", "size_t"]],
    });

    var PROT_READ   = 1;
    var PROT_WRITE  = 2;
    var PROT_EXEC   = 4;
    var MAP_PRIVATE = 2;
    var MAP_ANON    = os == "linux" || os == "linux2" ? 0x20 : 0x1000;

    return function(size) {
      var p = libc.mmap(ref.NULL, size,
                        PROT_READ | PROT_WRITE | PROT_EXEC,
                        MAP_PRIVATE | MAP_ANON, -1, 0);
      var ret = p.reinterpret(size);
      ret.free = function() {
        libc.munmap(p, size);
      };
      return ret;
    };
  }
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
  if (arch == "ia32") {
    codes += "\x8b\x5c\x24\x08";           // mov ebx, [esp+8]
  } else if (arch == "x64") {
    if (os == "win32") {
      codes += "\x52";                     // push rdx
      codes += "\x41\x50";                 // push r8
      codes += "\x48\x89\xcb";             // mov rbx, rcx
    } else {
      codes += "\x56";                     // push rsi
      codes += "\x52";                     // push rdx
      codes += "\x48\x89\xfb";             // mov rbx, rdi
    }
  }

  for (var pc = 0; pc < src.length; pc++) {
    switch (src[pc]) {
    case "+":
      codes += "\xfe\x03";                 // inc byte ptr[ebx|rbx]
      break;
    case "-":
      codes += "\xfe\x0b";                 // dec byte ptr[ebx|rbx]
      break;
    case ">":
      if (arch == "ia32") {
        codes += "\x43";                   // inc ebx
      } else if (arch == "x64") {
        codes += "\x48\xff\xc3";           // inc rbx
      }
      break;
    case "<":
      if (arch == "ia32") {
        codes += "\x4b";                   // dec ebx
      } else if (arch == "x64") {
        codes += "\x48\xff\xcb";           // dec rbx
      }
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
      if (arch == "ia32") {
        codes += "\x0f\xb6\x03";           // movzx eax, byte ptr[ebx]
        codes += "\x50";                   // push eax
        codes += "\xff\x54\x24\x10";       // call [esp+16]
        codes += "\x83\xc4\x04";           // add esp, 4
      } else if (arch == "x64") {
        if (os == "win32") {
          codes += "\x48\x83\xec\x20";     // sub rsp, 32
          codes += "\x0f\xb6\x0b";         // movzx ecx, byte ptr[rbx]
          codes += "\xff\x54\x24\x28";     // call [rsp+40]
          codes += "\x48\x83\xc4\x20";     // add rsp, 32
        } else {
          codes += "\x0f\xb6\x3b";         // movzx edi, byte ptr[rbx]
          codes += "\xff\x54\x24\x08";     // call [rsp+8]
        }
      }
      break;
    case ",":
      if (arch == "ia32") {
        codes += "\xff\x54\x24\x10";       // call [esp+16]
      } else if (arch == "x64") {
        if (os == "win32") {
          codes += "\x48\x83\xec\x20";     // sub rsp, 32
          codes += "\xff\x54\x24\x20";     // call [rsp+32]
          codes += "\x48\x83\xc4\x20";     // add rsp, 32
        } else {
          codes += "\xff\x14\x24";         // call [rsp]
        }
      }
      codes += "\x88\x03";                 // mov bytr ptr[ebx|rbx], al
      break;
    }
  }
  if (arch == "x64") {
    codes += "\x48\x83\xc4\x10";           // add rsp, 16
  }
  codes += "\x5b";                         // pop ebx|rbx
  codes += "\xc3";                         // ret

  var buf = jitalloc(codes.length);
  buf.binaryWrite(codes, 0);

  var func = ffi.ForeignFunction(buf, "void", ["pointer", "pointer", "pointer"]);
  var mem = new Buffer(30000);
  mem.fill(0, 0, 30000);

  var libcName = os == "win32" ? "msvcrt" : "libc" + ffi.Library.EXT;
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

