// V0 测试：扩展大脑 extensionLook.mjs（纯逻辑，LLM 注入替身，无网络无DB）
let passed = 0, failed = 0; const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; failures.push(msg); console.error("  ✗ " + msg); }
}

const M = await import("../src/extensionLook.mjs");

console.log("\n[组1] 薪资抽取");
{
  const a = M.extractSalaryFromText("岗位名称\n前端开发工程师\n6-8K·13薪\n深圳南山区");
  assert(a && a.salaryK === 7, "6-8K → 中值7K，matched=" + (a && a.matched));
  assert(a && a.monthsSalary === 13, "·13薪 识别");
  const b = M.extractSalaryFromText("月薪 8K 起");
  assert(b && b.salaryK === 8, "8K 单值");
  assert(b && b.monthsSalary == null, "无几薪 → null");
  const c = M.extractSalaryFromText("薪资面议，待遇从优");
  assert(c === null, "面议 → null");
  const d = M.extractSalaryFromText("日薪 300，月入 9K");
  assert(d && d.salaryK === 9, "日薪干扰下仍取 9K");
  const e = M.extractSalaryFromText("预算 15000 元/月");
  assert(e === null, "无K单位不误抽 15000");
  // 真机坑（2026-09-25）：联系人列表别的职位薪资先撞上 → 有职位卡锚点时只认卡头部
  const f = M.extractSalaryFromText("热门职位\n销售经理 19-25K\n杭州\n项目交付及运维工程师（驻北京昌平项目部）\n6-10K\n北京\n经验不限\n查看职位\nHR: 你好");
  assert(f && f.salaryK === 8 && f.matched.includes("6-10K"), "锚点前卡头优先，得" + (f && f.matched) + "，不抽19K");
  const g = M.extractSalaryFromText("销售经理 19-25K\n杭州\n经验不限\n学历不限\n五险一金\n单休\n加班补贴\n餐饮补贴\n查看职位\nHR: 你好");
  assert(g === null, "卡头6行窗口内无薪资 → null（宁缺勿错抽列表19K）");
}

console.log("\n[组2] 建议行解析");
{
  const rows = M.parseSuggestionLines(
    "追问薪资|您好，想确认一下这个岗位的薪资结构和发放方式。\n约面试|我这两天都方便，您定时间地点。\n3. 表态意向|我对岗位内容很感兴趣，希望能进一步沟通。"
  );
  assert(rows.length === 3, "三种格式（裸行/序号）都吃进，得" + rows.length);
  assert(rows[0].label === "追问薪资" && rows[0].text.startsWith("您好"), "标签/正文切分");
  assert(rows[2].label === "表态意向", "序号行标签去掉 3.");
  const phone = M.parseSuggestionLines("联系|我的电话是13812345678，加我微信");
  assert(phone.length === 1 && !phone[0].text.includes("13812345678") && phone[0].text.includes("[已隐藏]"), "正文手机号被 sanitize");
  const bad = M.parseSuggestionLines("这里没有任何分隔符的一行话\n第二行也没有");
  assert(bad.length === 0, "无竖线 → 0 条（触发兜底）");
  const dup = M.parseSuggestionLines("a|x\nb|x");
  assert(dup.length === 1, "正文重复去重");
  const long = M.parseSuggestionLines("a|" + "字".repeat(200));
  assert(long[0].text.length <= 160, "正文截断 ≤160");
}

console.log("\n[组3] buildLookResponse 三态");
{
  const fakeGen = async (prompt) => {
    if (!/短标签/.test(prompt)) throw new Error("prompt 缺格式要求");
    return "追问薪资|请问这个岗位底薪和提成比例分别是多少？\n约面试|方便的话约个时间面谈。\n表态意向|我看了职位描述，和我的方向挺匹配的。";
  };
  // 正常：有薪资有聊天
  const r1 = await M.buildLookResponse(
    { pageText: "HR: 我们招前端 6-8K·13薪\n我: 你好\nHR: Requirements: vue react\n职位：前端开发 6-8K\n聊天内容\nHR: 你什么时候方便来面试", commuteMode: "ebyke", oneWayKm: 5 },
    { env: { LLM_PROVIDER: "template" }, generateText: fakeGen }
  );
  assert(r1.ok && !r1.needManual, "面试邀约 → 正常出建议");
  assert(r1.suggestions.length === 3, "3 条建议");
  assert(r1.value.ok === true && r1.value.gross === 7000, "含金量卡用抽取中值 7000，gross=" + r1.value.gross);
  assert(r1.value.sources.gross === "职位卡自报", "薪资来源标注=职位卡自报");
  assert(r1.value.salaryMatched.includes("6-8K"), "salaryMatched 回显命中片段");

  // needManual：社保词 → 拦，但含金量卡仍要出
  const r2 = await M.buildLookResponse(
    { pageText: "HR: 我们五险一金按最低基数交\n职位：运营 8K", commuteMode: "none", oneWayKm: 0 },
    { env: { LLM_PROVIDER: "template" }, generateText: fakeGen }
  );
  assert(r2.needManual === true && r2.suggestions.length === 0, "offer/社保类 → needManual 且无建议");
  assert(r2.value.ok === true && r2.value.gross === 8000, "needManual 时含金量卡照常");

  // LLM 全挂 → 模板兜底 1 条标「兜底模板」
  const r3 = await M.buildLookResponse(
    { pageText: "HR: 薪资多少？\n职位：测试 5-6K", commuteMode: "metro", oneWayKm: 12 },
    { env: { LLM_PROVIDER: "template" }, generateText: async () => { throw new Error("gateway down"); } }
  );
  assert(r3.ok && !r3.needManual, "LLM 挂 → 仍 ok");
  assert(r3.suggestions.length === 1 && r3.suggestions[0].label === "兜底模板", "兜底模板 1 条");
  assert(r3.llmFailed === true, "llmFailed 标记透出");

  // 空页面
  const r4 = await M.buildLookResponse({ pageText: "   " }, { env: {}, generateText: fakeGen });
  assert(r4.ok && r4.noChat === true, "空 pageText → noChat");

  // 无薪资数字
  const r5 = await M.buildLookResponse(
    { pageText: "HR: 你好，对这个岗位有兴趣吗", commuteMode: "ebyke", oneWayKm: 5 },
    { env: { LLM_PROVIDER: "template" }, generateText: fakeGen }
  );
  assert(r5.value.ok === false && /未识别/.test(r5.value.reason), "无薪资 → value.ok=false 带 reason");

  // 输出红线：LLM 吐手机号 → 必被 sanitize
  const r6 = await M.buildLookResponse(
    { pageText: "HR: 方便留个联系方式吗\n职位 8K" },
    { env: { LLM_PROVIDER: "template" }, generateText: async () => "答|我的手机号是13812345678\n答|微信同号码" }
  );
  const joined = r6.suggestions.map(s => s.text).join("");
  assert(!/13812345678/.test(joined), "A5 输出守卫：LLM 吐手机号必被隐藏");
}

console.log("\n[组4] tailOfPageText（碎片过滤+句末起截，2026-09-25 真机坑）");
{
  const plain = M.tailOfPageText("aaa\nbbb\nccc\nddd\neee\nfff");
  assert(plain === "aaa bbb ccc ddd eee fff", "全短无标点行 → 碎片全滤后兜底退回原始最后8行，得「" + plain + "」");
  const long = M.tailOfPageText("x".repeat(10000));
  assert(long.length <= 220, "尾部截 220");
  // 职位卡碎片（≤12字无标点）不得混入意图输入
  const card = M.tailOfPageText("我: 能和您聊聊吗？很想加入贵团队！\n项目交付及运维工程师\n6-10K\n北京\n经验不限\n学历不限\n五险一金\n周末加班");
  assert(card === "我: 能和您聊聊吗？很想加入贵团队！", "卡片碎片被滤，只留最后一条消息句，得「" + card + "」");
}

console.log("\n[组5] 岗位名抽取 + 算式明细（2026-09-25 用户要求）");
{
  // 真机聊天页版式：HR行 → 职位卡标题 → 薪资 → 城市 → 查看职位
  const chatT = M.extractJobTitleFromText(
    "张女士 某某信息技术 HR 更多\n项目交付及运维工程师（驻北京昌平项目部）\n6-10K\n北京\n查看职位\n11:10 送达 能和您聊聊吗？"
  );
  assert(chatT === "项目交付及运维工程师（驻北京昌平项目部）", "聊天页跳过HR行取职位标题，得「" + chatT + "」");
  const detT = M.extractJobTitleFromText(
    "首页 搜索\n高中数学老师|全职兼职均可\n8-12K\n北京市朝阳区\n查看职位\n职位描述…",
    "https://www.zhipin.com/job_detail/abc.html"
  );
  assert(detT === "高中数学老师|全职兼职均可", "详情页取锚点前最近足量行，得「" + detT + "」");
  const noneT = M.extractJobTitleFromText("6-10K\n北京\n经验不限");
  assert(noneT === null, "全是噪音行 → null（宁缺勿滥）");
  const singleT = M.extractJobTitleFromText("张女士 某某信息技术 HR 更多 项目交付及运维工程师（驻北京昌平项目部） 6-10K 北京 查看职位");
  assert(singleT === null || singleT.length <= 60, "单行糊版式不乱抽（得「" + singleT + "」）");

  // 算式明细：随卡下发、含真实数字、到手行算式可对账
  const r = await M.buildLookResponse(
    { pageText: "张女士 某某信息技术 HR\n项目交付及运维工程师（驻北京昌平项目部）\n6-10K\n北京\n查看职位\n我: 能和您聊聊吗？很想加入贵团队！", commuteMode: "ebyke", oneWayKm: 5 },
    { env: { LLM_PROVIDER: "template" }, generateText: async () => "追问|请问办公地点在三门哪里？" }
  );
  assert(r.jobTitle === "项目交付及运维工程师（驻北京昌平项目部）", "响应带 jobTitle");
  const bd = r.value.breakdown || [];
  assert(bd.length >= 5, "明细 ≥5 行，得" + bd.length);
  // 区间薪资 → 到手/可支配如实显示为区间（用户 2026-09-25 指出「税前对不上」：6-10K 不该只报一个到手数）
  assert(Array.isArray(r.value.grossRange) && r.value.grossRange[0] === 6000 && r.value.grossRange[1] === 10000, "税前区间 [6000,10000]，得" + JSON.stringify(r.value.grossRange));
  assert(Array.isArray(r.value.netRange) && r.value.netRange[0] < r.value.netRange[1], "到手是区间，得" + JSON.stringify(r.value.netRange));
  const grossRow = bd.find((x) => x.label === "税前月薪");
  assert(grossRow && grossRow.value === "6000.00 ~ 10000.00" && /中值/.test(grossRow.formula), "税前行=区间两端，得「" + (grossRow && grossRow.value) + "」");
  const insRow = bd.find((x) => x.label === "五险一金（个人）");
  assert(insRow && /基数8000\.00/.test(insRow.formula) && insRow.value === "-1480.00", "五险一金行带中值基数与比例，扣" + (insRow && insRow.value));
  const netRow = bd.find((x) => x.label === "月到手");
  assert(netRow && /~/.test(netRow.value) && netRow.formula === "8000.00 − 1480.00 − 45.60", "到手行=区间，算式为中值示例：" + (netRow && netRow.value));
  const dispRow = bd.find((x) => x.label === "月可支配");
  assert(dispRow && /~/.test(dispRow.value), "可支配行=区间，得「" + (dispRow && dispRow.value) + "」");

  // 单值薪资（8K）→ 不产出区间，仍报单一数字
  const r1v = await M.buildLookResponse(
    { pageText: "HR: 在招 运营专员 8K\n北京\n查看职位\n我: 想了解下岗位细节。", commuteMode: "none", oneWayKm: 0 },
    { env: { LLM_PROVIDER: "template" }, generateText: async () => "追问|请问具体做什么？" }
  );
  assert(r1v.value.grossRange === null && r1v.value.netRange === null, "单值薪资 → 无区间，grossRange/netRange=null");
  assert(r1v.value.gross === 8000 && r1v.value.net > 0, "单值仍算得出到手，net=" + r1v.value.net);
}

console.log(`\n== ${passed} passed, ${failed} failed ==`);
if (failures.length) { console.error("FAILURES:\n" + failures.map(f => " - " + f).join("\n")); process.exit(1); }
