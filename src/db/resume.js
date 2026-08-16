// Autonomous Job Search Agent
// Resume CRUD
import { getDb } from "./index.js";
export function findAll() { return getDb().prepare("SELECT * FROM Resume ORDER BY isDefault DESC, updatedAt DESC").all(); }
export function findById(id) { return getDb().prepare("SELECT * FROM Resume WHERE id = ?").get(id); }
export function findDefault() { return getDb().prepare("SELECT * FROM Resume WHERE isDefault = 1 LIMIT 1").get(); }
export function findByTag(tag) { return getDb().prepare("SELECT * FROM Resume WHERE tags LIKE ? ORDER BY updatedAt DESC").all("%" + tag + "%"); }
export function create(data) {
    var d = getDb();
    if (data.isDefault) {
        d.prepare("UPDATE Resume SET isDefault = 0").run();
    }
    var info = d.prepare("INSERT INTO Resume (name, targetRole, tags, filePath, fileType, isDefault, description, rawText, skills) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(data.name, data.targetRole || null, data.tags || null, data.filePath || null, data.fileType || null, data.isDefault ? 1 : 0, data.description || null, data.rawText || null, data.skills || null);
    return findById(info.lastInsertRowid);
}
export function update(id, data) {
    var d = getDb();
    if (data.isDefault) {
        d.prepare("UPDATE Resume SET isDefault = 0").run();
    }
    var sets = [];
    var vals = [];
    for (var k in data) {
        if (data[k] !== undefined) {
            sets.push(k + " = ?");
            vals.push(typeof data[k] === "boolean" ? (data[k] ? 1 : 0) : data[k]);
        }
    }
    if (sets.length === 0)
        return findById(id);
    sets.push("updatedAt = datetime('now')");
    vals.push(id);
    d.prepare("UPDATE Resume SET " + sets.join(", ") + " WHERE id = ?").run(...vals);
    return findById(id);
}
export function remove(id) {
    var d = getDb();
    var target = findById(id);
    var ok = d.prepare("DELETE FROM Resume WHERE id = ?").run(id).changes > 0;
    if (ok && target?.isDefault) {
        var next = d.prepare("SELECT * FROM Resume ORDER BY updatedAt DESC LIMIT 1").get();
        if (next) {
            d.prepare("UPDATE Resume SET isDefault = 1, updatedAt = datetime('now') WHERE id = ?").run(next.id);
        }
    }
    return ok;
}
export function findBestMatch(technologies) {
    var all = findAll();
    if (all.length === 0)
        return undefined;
    if (!technologies || technologies.length === 0)
        return findDefault() || all[0];
    var best = undefined;
    var bestScore = -1;
    for (var i = 0; i < all.length; i++) {
        var r = all[i];
        var score = r.isDefault ? 5 : 0;
        if (r.skills) {
            for (var j = 0; j < technologies.length; j++) {
                if (r.skills.toLowerCase().indexOf(technologies[j].toLowerCase()) !== -1) {
                    score += 3;
                }
            }
        }
        if (score > bestScore) {
            bestScore = score;
            best = r;
        }
    }
    return best;
}
