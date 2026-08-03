// Autonomous Job Search Agent
// Company CRUD

import { getDb } from "./index.js";

export function findAll(search) {
  var d = getDb();
  if (search) { return d.prepare("SELECT * FROM Company WHERE name LIKE ? OR industry LIKE ? ORDER BY name").all("%" + search + "%", "%" + search + "%"); }
  return d.prepare("SELECT * FROM Company ORDER BY name").all();
}

export function findById(id) { return getDb().prepare("SELECT * FROM Company WHERE id = ?").get(id); }
export function findByName(name) { return getDb().prepare("SELECT * FROM Company WHERE name = ?").get(name); }

export function create(data) {
  var d = getDb();
  var info = d.prepare("INSERT INTO Company (name, shortName, industry, size, stage, website, description) VALUES (?, ?, ?, ?, ?, ?, ?)").run(data.name, data.shortName||null, data.industry||null, data.size||null, data.stage||null, data.website||null, data.description||null);
  return findById(info.lastInsertRowid);
}

export function update(id, data) {
  var d = getDb(); var sets = []; var vals = [];
  for (var k in data) { if (data[k] !== undefined) { sets.push(k + " = ?"); vals.push(data[k]); } }
  if (sets.length === 0) return findById(id);
  sets.push("updatedAt = datetime('now')"); vals.push(id);
  d.prepare("UPDATE Company SET " + sets.join(", ") + " WHERE id = ?").run(...vals);
  return findById(id);
}

export function remove(id) { return getDb().prepare("DELETE FROM Company WHERE id = ?").run(id).changes > 0; }
