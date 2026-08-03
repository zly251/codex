# Edit Boss.java and Liepin.java - replace fixed sleeps with random delays

def edit_boss():
    path = r"E:\autonomous-job-agent\get_jobs\src\main\java\com\getjobs\worker\boss\Boss.java"
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()

    # Track replacements count
    replacements = []

    for i, line in enumerate(lines):
        stripped = line.strip()

        # Line 1: updateBlacklistFromChats - sleep(3) after navigate
        if "PlaywrightUtil.sleep(3);" in stripped:
            prev = lines[i - 1].strip() if i > 0 else ""
            if "navigate" in prev or i == 117:  # line 118 (0-indexed 117)
                replacements.append((i, stripped.replace("sleep(3)", "sleepRandom(2.0, 4.0)")))
                continue

        # Handle sleep(1) replacements - match the pattern
        if "PlaywrightUtil.sleep(1);" in stripped:
            prev = lines[i - 1].strip() if i > 0 else ""
            lines[i - 2].strip() if i > 1 else ""
            next_line = lines[i + 1].strip() if i < len(lines) - 1 else ""

            # Context-based replacement
            if "navigate" in prev and "detailUrl" in prev:
                replacements.append((i, stripped.replace("sleep(1)", "sleepRandom(1.5, 3.5)")))
            elif (
                "chatBtn" in prev and "foundChatBtn" in lines[i + 2].strip()
                if i + 2 < len(lines)
                else False
            ):
                replacements.append((i, stripped.replace("sleep(1)", "sleepRandom(0.8, 2.0)")))
            elif "chatBtn" in prev or ("click()" in prev and "chatBtn" in prev):
                replacements.append((i, stripped.replace("sleep(1)", "sleepRandom(1.5, 3.5)")))
            elif "inputReady" in prev:
                replacements.append((i, stripped.replace("sleep(1)", "sleepRandom(0.5, 1.5)")))
            elif "sendText" in prev and "click()" in prev:
                replacements.append((i, stripped.replace("sleep(1)", "sleepRandom(1.0, 2.5)")))
            elif "detailPage.close()" in prev or "detailPage.close" in prev:
                replacements.append((i, stripped.replace("sleep(1)", "sleepRandom(0.5, 1.5)")))
            elif "chooserHandled" in prev or "chooser" in prev:
                replacements.append((i, stripped.replace("sleep(1)", "sleepRandom(1.0, 2.5)")))
            elif (
                "setInputFiles" in prev
                or "滑块" in prev
                or "slider" in prev
                or "滑块验证" in next_line
            ):
                replacements.append((i, stripped.replace("sleep(1)", "sleepRandom(0.5, 1.5)")))
            else:
                # Generic postJobByCity or other sleeps
                replacements.append((i, stripped.replace("sleep(1)", "sleepRandom(0.8, 2.0)")))

    # Apply replacements (from end to start to preserve indices)
    for i, new_line in reversed(replacements):
        indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
        lines[i] = indent + new_line + "\n"

    # Also add inter-job random delay: after resumeSubmission() call and before log.info / postCount++
    # Find the pattern: line ending with resumeSubmission and the next is postCount++
    insert_positions = []
    for i in range(len(lines) - 1):
        if "resumeSubmission(keyword, job);" in lines[i].strip():
            # Check the next non-comment/blank line
            j = i + 1
            while j < len(lines) and (lines[j].strip() == "" or lines[j].strip().startswith("//")):
                j += 1
            if j < len(lines) and "postCount++" in lines[j]:
                insert_positions.append(j)

    # Insert random delay before postCount++
    for pos in reversed(insert_positions):
        indent = lines[pos][: len(lines[pos]) - len(lines[pos].lstrip())]
        lines.insert(pos, indent + "PlaywrightUtil.sleepRandom(2.0, 5.0);\n")

    # Randomize scroll amount
    for i, line in enumerate(lines):
        if "window.scrollBy(0, 140)" in line:
            lines[i] = line.replace(
                "window.scrollBy(0, 140)", "window.scrollBy(0, 50 + (int)(Math.random() * 150))"
            )

    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)

    print(f"Boss.java updated: {len(replacements)} sleep replacements + random delay added")


def edit_liepin():
    path = r"E:\autonomous-job-agent\get_jobs\src\main\java\com\getjobs\worker\liepin\Liepin.java"
    with open(path, encoding="utf-8") as f:
        content = f.read()

    # Replace PlaywrightUtil.sleep(1) with random
    content = content.replace("PlaywrightUtil.sleep(1);", "PlaywrightUtil.sleepRandom(0.8, 2.0);")

    # Replace Thread.sleep(500)
    content = content.replace(
        "Thread.sleep(500);", "Thread.sleep(200 + (int)(Math.random() * 600));"
    )

    # Replace Thread.sleep(50) x 4 (mouse fine-tuning)
    for _ in range(4):
        content = content.replace(
            "Thread.sleep(50);", "Thread.sleep(30 + (int)(Math.random() * 60));", 1
        )

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

    print("Liepin.java updated")


edit_boss()
edit_liepin()
