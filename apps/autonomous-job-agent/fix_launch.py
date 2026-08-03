p = r"E:\autonomous-job-agent\get_jobs\src\main\java\com\getjobs\worker\manager\PlaywrightManager.java"
with open(p, encoding="utf-8") as f:
    lines = f.readlines()
for i, line in enumerate(lines):
    if "start-maximized" in line and "disable-blink" not in "".join(lines[i : i + 3]):
        indent = " " * (len(line) - len(line.lstrip()))
        lines.insert(
            i + 1,
            indent
            + "&quot;--disable-blink-features=AutomationControlled&quot; // 隐藏自动化标记"
            + chr(10),
        )
        break
with open(p, "w", encoding="utf-8") as f:
    f.writelines(lines)
print("Done")
