// Shared skill extraction utilities
export var TECH_KEYWORDS = [
    "c++", "qt", "librecad", "cad", "opengl", "occ",
    "opencascade", "python", "java", "javascript", "typescript",
    "linux", "windows", "mfc", "cmake", "git",
    "docker", "k8s", "kubernetes",
    "spring", "vue", "react", "node",
    "mysql", "redis", "database",
    "algorithm", "machine learning", "deep learning",
];
export function extractSkills(text) {
    var result = [];
    var lower = text.toLowerCase();
    for (var i = 0; i < TECH_KEYWORDS.length; i++) {
        var kw = TECH_KEYWORDS[i];
        if (lower.indexOf(kw) !== -1) {
            // Check word boundary for letter-based keywords
            if (/^[a-zA-Z]/.test(kw)) {
                var idx = lower.indexOf(kw);
                var before = idx > 0 ? lower[idx - 1] : " ";
                var afterIdx = idx + kw.length;
                var after = afterIdx < lower.length ? lower[afterIdx] : " ";
                var isWord = (/[a-z0-9]/.test(before)) === false && (/[a-z0-9]/.test(after)) === false;
                if (isWord) {
                    if (result.indexOf(kw) === -1)
                        result.push(kw);
                }
            }
            else {
                if (result.indexOf(kw) === -1)
                    result.push(kw);
            }
        }
    }
    return result;
}
export function countSkillMatches(skillsStr, techList) {
    if (!skillsStr || !techList || techList.length === 0)
        return 0;
    var count = 0;
    var lower = skillsStr.toLowerCase();
    for (var i = 0; i < techList.length; i++) {
        if (lower.indexOf(techList[i].toLowerCase()) !== -1)
            count++;
    }
    return count;
}
