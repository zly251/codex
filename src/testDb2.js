// Autonomous Job Search Agent
// Test database initialization
import { resetDb, getDbInfo } from './db/index.js';
import * as company from './db/company.js';
import * as job from './db/job.js';
import * as resume from './db/resume.js';
import * as application from './db/application.js';
function assert(cond, msg) {
    if (!cond)
        throw new Error('ASSERT ' + msg);
    console.log("  OK " + msg);
}
function main() {
    console.log("");
    console.log("=== DB test ===");
    resetDb();
    var info = getDbInfo();
    assert(info.tableCount === 4, "4 tables: " + info.tableCount);
    console.log("");
    console.log("--- Company ---");
    var c1 = company.create({ name: "testCo", industry: "IT", size: "100" });
    assert(c1.id > 0, "create: " + c1.name);
    assert(company.findByName("testCo").id === c1.id, "findByName");
    company.update(c1.id, { industry: "SW" });
    assert(company.findById(c1.id).industry === "SW", "update");
    assert(company.findAll().length === 1, "findAll");
    console.log("");
    console.log("--- Job ---");
    var j1 = job.create({ title: "C++ Dev", salaryMin: 20, salaryMax: 35, city: "BJ", url: "https://zhipin.com/x1.html", technologies: "C++,Qt" });
    assert(j1.id > 0, "create job");
    assert(job.findByUrl(j1.url).id === j1.id, "findByUrl");
    assert(job.search({ keywords: "C++" }).length >= 1, "search");
    console.log("");
    console.log("--- Resume ---");
    var r1 = resume.create({ name: "Dev", isDefault: true, skills: "C++,Qt" });
    assert(r1.id > 0, "create resume");
    assert(resume.findDefault().id === r1.id, "default");
    console.log("");
    console.log("--- Application ---");
    var a1 = application.create({ jobId: j1.id, resumeId: r1.id, status: "pending" });
    assert(a1.id > 0, "create app");
    application.updateStatus(a1.id, "interview", "ok");
    assert(application.findById(a1.id).status === "interview", "update");
    var stats = application.getStats();
    assert(stats.interview === 1, "stats ok");
    console.log("");
    console.log("ALL PASS");
}
main().catch(function (err) { console.error("FAIL: " + err.message); process.exit(1); });
