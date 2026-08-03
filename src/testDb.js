// Autonomous Job Search Agent
// Test database initialization
import { resetDb, getDbInfo } from './db/index.js';
import * as company from './db/company.js';
import * as job from './db/job.js';
import * as resume from './db/resume.js';
import * as application from './db/application.js';
var testsPassed = 0;
var testsFailed = 0;
function assert(cond, msg) {
    if (cond) {
        testsPassed++;
        console.log("  OK " + msg);
    }
    else {
        testsFailed++;
        console.log("  FAIL " + msg);
    }
}
function main() {
    console.log("");
    console.log("=== Phase 1: DB Layer Test ===");
    resetDb();
    var info = getDbInfo();
    assert(info.tableCount === 4, "4 tables: " + info.tableCount);
    console.log("");
    console.log("--- Company CRUD ---");
    var c1 = company.create({ name: "testCo", industry: "IT", size: "100" });
    assert(c1 && c1.id > 0, "create: " + (c1 ? c1.name : "null"));
    assert(company.findByName("testCo") !== null, "findByName");
    company.update(c1.id, { industry: "SW" });
    assert(company.findById(c1.id).industry === "SW", "update");
    assert(company.findAll().length === 1, "findAll");
    console.log("");
    console.log("--- Job CRUD ---");
    var j1 = job.create({ title: "C++ Dev", salaryMin: 20, salaryMax: 35, city: "BJ", url: "https://zhipin.com/x1.html", technologies: "C++,Qt" });
    assert(j1 && j1.id > 0, "create job");
    assert(job.findByUrl(j1.url) !== null, "findByUrl");
    assert(job.search({ keywords: "C++" }).length >= 1, "search");
    console.log("");
    console.log("--- Resume CRUD ---");
    var r1 = resume.create({ name: "Dev", isDefault: true, skills: "C++,Qt" });
    assert(r1 && r1.id > 0, "create resume");
    assert(resume.findDefault() !== null, "default");
    console.log("");
    console.log("--- Application CRUD ---");
    var a1 = application.create({ jobId: j1.id, resumeId: r1.id, status: "pending" });
    assert(a1 && a1.id > 0, "create app");
    application.updateStatus(a1.id, "interview", "ok");
    assert(application.findById(a1.id).status === "interview", "update");
    var stats = application.getStats();
    assert(stats.interview === 1, "stats ok");
    console.log("");
    if (testsFailed > 0) {
        console.log("FAILED: " + testsPassed + " passed, " + testsFailed + " failed");
        process.exit(1);
    }
    else {
        console.log("ALL PASS (" + testsPassed + "/" + testsPassed + ")");
    }
}
try {
    main();
}
catch (e) {
    console.error("ERROR: " + e.message);
    process.exit(1);
}
