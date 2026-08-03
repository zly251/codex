import sys, os, json, threading, queue
from pathlib import Path
import tkinter as tk
from tkinter import font as tkfont

sys.path.insert(0, str(Path(__file__).parent))

from agent.deepseek_client import DeepSeekClient
from agent.web_search import WebSearch
from agent.video_generator import VideoGenerator
from douyin.uploader import DouyinUploader
from config import DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, OUTPUT_DIR, BROWSER_DATA_DIR


# DeepSeek-style color palette
BG = "#f5f5f0"
CARD = "#ffffff"
PRIMARY = "#4f6af5"
PRIMARY_HOVER = "#3b5de7"
TEXT = "#1f2937"
TEXT_SEC = "#6b7280"
BORDER = "#e5e7eb"
SUCCESS = "#10b981"
ERROR = "#ef4444"
INPUT_BG = "#f9fafb"


class PipeIO:
    def __init__(self, q):
        self.q = q
    def write(self, s):
        if s.strip():
            self.q.put(s)
    def flush(self):
        pass


class App:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Douyin Agent")
        self.root.geometry("820x640")
        self.root.minsize(600, 480)
        self.root.configure(bg=BG)

        cx = self.root.winfo_screenwidth()
        cy = self.root.winfo_screenheight()
        self.root.geometry(f"+{(cx-820)//2}+{(cy-640)//2}")
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self.log_q = queue.Queue()
        self._running = False

        # load fonts
        self._setup_fonts()
        self._build_ui()
        self._poll()

    def _setup_fonts(self):
        families = [f for f in tkfont.families()]
        if "Microsoft YaHei UI" in families:
            self.FONT = "Microsoft YaHei UI"
        elif "Microsoft YaHei" in families:
            self.FONT = "Microsoft YaHei"
        elif "Segoe UI" in families:
            self.FONT = "Segoe UI"
        else:
            self.FONT = "TkDefaultFont"

    def _make_card(self, parent, **kw):
        f = tk.Frame(parent, bg=CARD, highlightbackground=BORDER,
                     highlightthickness=1, **kw)
        return f

    def _build_ui(self):
        # === HEADER ===
        hdr = tk.Frame(self.root, bg=BG, height=56)
        hdr.pack(fill="x", padx=28, pady=(20, 0))
        tk.Label(hdr, text="Douyin Agent", fg=TEXT, bg=BG,
                 font=(self.FONT, 18, "bold")).pack(side="left")
        tk.Label(hdr, text="\u77ed\u89c6\u9891\u751f\u6210  +  \u53d1\u5e03",
                 fg=TEXT_SEC, bg=BG,
                 font=(self.FONT, 11)).pack(side="left", padx=(12, 0))

        # === API KEY ROW ===
        akr = tk.Frame(self.root, bg=BG)
        akr.pack(fill="x", padx=28, pady=(12, 0))
        tk.Label(akr, text="API Key", fg=TEXT_SEC, bg=BG,
                 font=(self.FONT, 10)).pack(side="left")
        self.api_key_var = tk.StringVar()
        saved = self._load_key()
        if saved:
            self.api_key_var.set(saved)
        ak_entry = tk.Entry(akr, textvariable=self.api_key_var, show="*",
                            bg=INPUT_BG, fg=TEXT, insertbackground=TEXT,
                            relief="solid", bd=1, font=(self.FONT, 10), width=36,
                            highlightbackground=BORDER, highlightcolor=PRIMARY,
                            highlightthickness=1)
        ak_entry.pack(side="left", padx=(12, 0), fill="x", expand=True, ipady=4)
        ak_entry.bind("<KeyRelease>", lambda e: self._save_key())

        # === MAIN CARD ===
        main_card = self._make_card(self.root)
        main_card.pack(fill="both", expand=True, padx=28, pady=(16, 10))

        # --- output area ---
        of = tk.Frame(main_card, bg=CARD)
        of.pack(fill="both", expand=True, padx=12, pady=(12, 8))
        self.output = tk.Text(of, bg=CARD, fg=TEXT,
                              relief="flat", bd=0, font=("Consolas", 10),
                              wrap="word", state="disabled",
                              padx=4, pady=4)
        self.output.pack(fill="both", expand=True, side="left")
        scroll = tk.Scrollbar(of, command=self.output.yview,
                              bg=BORDER, troughcolor=CARD,
                              relief="flat", bd=0, width=8)
        scroll.pack(side="right", fill="y")
        self.output.configure(yscrollcommand=scroll.set)
        self.output.tag_configure("cmd", foreground=PRIMARY)
        self.output.tag_configure("done", foreground=SUCCESS)
        self.output.tag_configure("err", foreground=ERROR)

        # --- input row ---
        ir = tk.Frame(main_card, bg=CARD)
        ir.pack(fill="x", padx=12, pady=(0, 12))
        self.cmd_var = tk.StringVar()
        cmd_entry = tk.Entry(ir, textvariable=self.cmd_var,
                             bg=INPUT_BG, fg=TEXT_SEC, insertbackground=TEXT,
                             relief="solid", bd=1, font=(self.FONT, 11),
                             highlightbackground=BORDER, highlightcolor=PRIMARY,
                             highlightthickness=1)
        cmd_entry.pack(side="left", fill="x", expand=True, ipady=6)
        cmd_entry.insert(0, "\u641c\u7d22\u70ed\u70b9\u8bdd\u9898\uff0c\u751f\u6210\u89c6\u9891...")
        cmd_entry.bind("<FocusIn>", lambda e: self._focus_in(cmd_entry))
        cmd_entry.bind("<FocusOut>", lambda e: self._focus_out(cmd_entry))
        cmd_entry.bind("<Return>", lambda e: self._run())

        self.send_btn = tk.Button(ir, text="\u53d1\u9001", command=self._run,
                                  bg=PRIMARY, fg="white", relief="flat",
                                  font=(self.FONT, 11, "bold"),
                                  cursor="hand2", padx=20, pady=6,
                                  activebackground=PRIMARY_HOVER)
        self.send_btn.pack(side="left", padx=(8, 0))

        # === STATUS BAR ===
        st = tk.Frame(self.root, bg=BG)
        st.pack(fill="x", padx=28, pady=(0, 14))
        self.status_label = tk.Label(st, text="\u5c31\u7eea",
                                     fg=TEXT_SEC, bg=BG, font=(self.FONT, 9))
        self.status_label.pack(side="left")
        tk.Label(st, text="v0.1 MVP", fg=TEXT_SEC, bg=BG,
                 font=(self.FONT, 9)).pack(side="right")

    # ---------- helpers ----------

    def _load_key(self):
        try:
            p = Path.home() / ".douyin_agent_key"
            if p.exists():
                return p.read_text(encoding="utf-8").strip()
        except Exception:
            pass
        return ""

    def _save_key(self):
        try:
            Path.home().joinpath(".douyin_agent_key").write_text(
                self.api_key_var.get(), encoding="utf-8")
        except Exception:
            pass

    def _focus_in(self, e):
        ph = "\u641c\u7d22\u70ed\u70b9\u8bdd\u9898\uff0c\u751f\u6210\u89c6\u9891..."
        if e.get() == ph:
            e.delete(0, "end")
            e.configure(fg=TEXT)

    def _focus_out(self, e):
        if not e.get().strip():
            ph = "\u641c\u7d22\u70ed\u70b9\u8bdd\u9898\uff0c\u751f\u6210\u89c6\u9891..."
            e.insert(0, ph)
            e.configure(fg=TEXT_SEC)

    def _log(self, text, tag="info"):
        self.output.configure(state="normal")
        self.output.insert("end", text + chr(10), tag)
        self.output.see("end")
        self.output.configure(state="disabled")

    # ---------- agent ----------

    def _run_agent(self, cmd, api_key):
        topic = ""
        if cmd.startswith("topic "):
            topic = cmd[6:].strip()
        elif cmd == "upload" or cmd.startswith("upload "):
            # upload mode
            searcher = WebSearch()
            uploader = DouyinUploader(data_dir=BROWSER_DATA_DIR)
            path_part = cmd[7:].strip() if cmd.startswith("upload ") else ""
            if not path_part:
                files = list(OUTPUT_DIR.glob("*.mp4"))
                if not files:
                    print("output/ \u4e2d\u6ca1\u6709\u89c6\u9891\u6587\u4ef6")
                    return
                path_part = str(files[-1])
                print(f"\u9009\u62e9: {files[-1].name}")
            uploader.start()
            uploader.login()
            uploader.upload(path_part)
            print("[done] \u4e0a\u4f20\u5b8c\u6210")
            return
        else:
            # natural language -> treat as topic
            topic = cmd

        if not topic:
            print("\u8bf7\u8f93\u5165\u8981\u751f\u6210\u89c6\u9891\u7684\u4e3b\u9898")
            return

        client = DeepSeekClient(api_key=api_key,
                                base_url=DEEPSEEK_BASE_URL,
                                model=DEEPSEEK_MODEL)
        searcher = WebSearch()
        video_gen = VideoGenerator(output_dir=OUTPUT_DIR)

        def search_web(query):
            return json.dumps(searcher.search(query), ensure_ascii=False)
        client.register_tool("web_search", "Search web for latest info",
            {"type": "object", "properties": {"query": {"type": "string"}},
             "required": ["query"]}, search_web)

        def search_news(query):
            return json.dumps(searcher.search_news(query), ensure_ascii=False)
        client.register_tool("web_search_news", "Search latest news",
            {"type": "object", "properties": {"query": {"type": "string"}},
             "required": ["query"]}, search_news)

        print(f"[1/4] \u641c\u7d22: {topic}")
        messages = [
            {"role": "system", "content":
             f"You are a short-video script writer. Topic: {topic}. "
             "Use web_search to search hot topics, "
             "then write a 60-second script."},
            {"role": "user", "content":
             f"Create a short-video script about: {topic}"},
        ]
        resp = client.chat(messages, temperature=0.8)
        print("[2/4] \u811a\u672c\u5df2\u751f\u6210")
        lines = resp.strip().split(chr(10))
        title = topic
        content_lines = []
        for line in lines:
            line = line.strip()
            if line.startswith("[TITLE]") or line.startswith("# "):
                title = line.replace("[TITLE]", "").replace("# ", "").strip()
            elif line.startswith("[CONTENT]"):
                content_lines.append(line.replace("[CONTENT]", "").strip())
            else:
                content_lines.append(line)
        content = chr(10).join(content_lines) or resp
        print("[3/4] \u751f\u6210\u89c6\u9891\u4e2d...")
        safe_name = topic.replace(" ", "_")[:30]
        video_path = video_gen.generate_video(
            title, content, output_name=f"{safe_name}.mp4")
        print(f"[done] \u89c6\u9891\u5df2\u751f\u6210: {video_path}")
        print("[done] \u89c6\u9891\u5df2\u4fdd\u5b58\u5230\u8f93\u51fa\u76ee\u5f55\uff0c\u53ef\u8f93\u5165 upload \u4e0a\u4f20\u6296\u97f3")

    def _worker(self, cmd, api_key):
        sys.stdout = PipeIO(self.log_q)
        try:
            self._run_agent(cmd, api_key)
        except Exception as e:
            self.log_q.put(f"[error] {e}")
        finally:
            self.log_q.put("__DONE__")

    def _run(self):
        cmd = self.cmd_var.get().strip()
        if not cmd:
            return
        api_key = self.api_key_var.get().strip()
        if not api_key:
            self._log("\u8bf7\u5148\u8f93\u5165 API Key", "err")
            return
        if self._running:
            return
        self._running = True
        self.send_btn.configure(state="disabled")
        self.status_label.configure(text="\u8fd0\u884c\u4e2d...")
        self._log(f"> {cmd}", "cmd")
        threading.Thread(target=self._worker, args=(cmd, api_key), daemon=True).start()

    def _poll(self):
        try:
            while True:
                msg = self.log_q.get_nowait()
                if msg == "__DONE__":
                    self._running = False
                    self.send_btn.configure(state="normal")
                    self.status_label.configure(text="\u5c31\u7eea")
                    return
                tag = "info"
                if msg.startswith("[error]"):
                    tag = "err"
                elif msg.startswith("[done]"):
                    tag = "done"
                self._log(msg, tag)
        except queue.Empty:
            pass
        self.root.after(100, self._poll)

    def _on_close(self):
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    App().run()
