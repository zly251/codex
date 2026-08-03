import re

WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
OLD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"

p1 = r"E:\autonomous-job-agent\get_jobs\src\main\java\com\getjobs\worker\manager\PlaywrightManager.java"
with open(p1, encoding="utf-8") as f:
    c = f.read()
c = c.replace(OLD_UA, WINDOWS_UA)
with open(p1, "w", encoding="utf-8") as f:
    f.write(c)
print("PlaywrightManager done")

p2 = r"E:\autonomous-job-agent\get_jobs\src\main\java\com\getjobs\worker\utils\PlaywrightUtil.java"
with open(p2, encoding="utf-8") as f:
    c = f.read()
c = c.replace('"macOS"', '"Windows"')
c = c.replace(OLD_UA, WINDOWS_UA)
old_init = "Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3]});"
new_init = "Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});"
c = c.replace(old_init, new_init)
# also remove the injected override
c = c.replace("Object.defineProperty(navigator, 'injected', {get: () => 123});\n", "")
with open(p2, "w", encoding="utf-8") as f:
    f.write(c)
print("PlaywrightUtil done")
print("All done!")
