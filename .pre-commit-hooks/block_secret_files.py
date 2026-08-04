import subprocess


def main() -> int:
    output = subprocess.check_output(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
        text=True,
    )
    blocked = []
    for path in output.splitlines():
        normalized = path.replace("\\", "/")
        if (
            normalized.endswith(".key")
            or normalized.endswith(".pem")
            or normalized == ".env"
            or normalized.endswith("/.env")
        ):
            blocked.append(path)
    if blocked:
        print("Blocked secret files:")
        for path in blocked:
            print(" - " + path)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
