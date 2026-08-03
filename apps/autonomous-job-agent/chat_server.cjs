const http = require("http");
const fs = require("fs");
const path = require("path");

var DATA_FILE = path.join(__dirname, "..", "data", "chat.json");
var messages = [];
try {
  if (fs.existsSync(DATA_FILE)) messages = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch(e) {}

var PAGE = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Codex 聊天</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:0;background:#f0f2f5;height:100vh;display:flex;align-items:center;justify-content:center}#app{width:100%;max-width:600px;height:100vh;display:flex;flex-direction:column;background:#fff;box-shadow:0 0 20px rgba(0,0,0,0.1)}#header{background:#1565c0;color:#fff;padding:16px 20px;font-size:18px;font-weight:600;text-align:center}#msg-box{flex:1;overflow-y:auto;padding:16px;background:#f5f7fa}.msg{margin:8px 0;display:flex}.msg.user{justify-content:flex-end}.msg .b{max-width:75%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.5;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,0.06)}.msg.user .b{background:#1565c0;color:#fff;border-bottom-right-radius:4px}.msg.bot .b{background:#fff;color:#333;border-bottom-left-radius:4px}#input-area{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #eee;background:#fff}#input-area input{flex:1;padding:10px 14px;border:1px solid #ddd;border-radius:20px;font-size:14px;outline:none}#input-area button{background:#1565c0;color:#fff;border:none;border-radius:20px;padding:10px 20px;cursor:pointer;font-size:14px}</style></head><body><div id="app"><div id="header">💬 Codex 聊天</div><div id="msg-box"></div><div id="input-area"><input id="inp" placeholder="输入消息..."><button id="sendBtn">发送</button></div></div><script>var e=document.getElementById("msg-box");var inp=document.getElementById("inp");var btn=document.getElementById("sendBtn");var lastId=0;function l(){var x=new XMLHttpRequest();x.open("GET","/api/chat/messages?after="+lastId,true);x.onload=function(){try{var d=JSON.parse(x.responseText);if(d.messages&&d.messages.length){lastId=d.lastId;for(var i=0;i<d.messages.length;i++){var m=d.messages[i];var c="msg "+(m.from==="user"?"user":"bot");var msgDiv=document.createElement("div");msgDiv.className=c;var bubble=document.createElement("div");bubble.className="b";bubble.textContent=m.text;msgDiv.appendChild(bubble);e.appendChild(msgDiv)}e.scrollTop=e.scrollHeight}}catch(ex){}setTimeout(l,3000)};x.send()}function s(){var t=inp.value.trim();if(!t)return;inp.value="";var x=new XMLHttpRequest();x.open("POST","/api/chat/send",true);x.setRequestHeader("Content-Type","application/json");x.onload=function(){l()};x.send(JSON.stringify({text:t}))}btn.addEventListener("click",s);inp.addEventListener("keydown",function(ev){if(ev.keyCode===13)s()});l()</script></body></html>';

var server = http.createServer(function(req, res) {
  var url = new URL(req.url, "http://localhost");
  var p = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end("{}"); return; }

  if (p === "/" || p === "/index.html") {
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end(PAGE);
    return;
  }

  if (p === "/api/chat/messages" && req.method === "GET") {
    var after = parseInt(url.searchParams.get("after") || "0");
    var newMsgs = messages.filter(function(m) { return m.id > after; });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ messages: newMsgs, lastId: messages.length ? messages[messages.length - 1].id : 0 }));
    return;
  }

  if (p === "/api/chat/send" && req.method === "POST") {
    var body = "";
    req.on("data", function(c) { body += c; });
    req.on("end", function() {
      try {
        var data = JSON.parse(body);
        var text = (data.text || "").trim();
        if (!text) { res.writeHead(400); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: "消息为空" })); return; }
        var msg = { id: messages.length + 1, text: text, from: "user", time: new Date().toISOString() };messages.push(msg);var reply = { id: messages.length + 1, text: "✅ 已收到: " + text.slice(0,30), from: "bot", time: new Date().toISOString() };messages.push(reply);try{fs.writeFileSync(DATA_FILE,JSON.stringify(messages),"utf8")}catch(e){}
        messages.push(msg);

        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, id: msg.id }));
      } catch(e) { res.writeHead(400); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

var PORT = 3461;
server.listen(PORT, function() {
  console.log("Chat server: http://localhost:" + PORT);
});
