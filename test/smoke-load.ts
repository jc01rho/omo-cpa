import ext from "/home/whrho/.omo/agent/extensions/omo-cpa.ts";
const hooks: string[] = [];
const cmds: string[] = [];
ext({
  on: (e: string) => hooks.push(e),
  registerCommand: (n: string) => cmds.push(n),
  sendMessage: () => {},
});
console.log("훅 등록:", hooks.join(", "));
console.log("명령 등록:", cmds.join(", "));
console.log("설치 경로에서 로드 성공");
