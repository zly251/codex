const fs = require("fs");
const lines = [];
// Read from stdin and write to file
process.stdin.setEncoding("utf8");
let data = "";
process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(process.argv[2], data, "utf8");
  console.log("written: " + data.length + " bytes");
});