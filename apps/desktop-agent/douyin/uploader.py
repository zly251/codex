from playwright.sync_api import sync_playwright

CREATOR_URL = "https://creator.douyin.com/"


class DouyinUploader:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None

    def start(self):
        self._playwright = sync_playwright().start()
        self._context = self._playwright.chromium.launch_persistent_context(
            str(self.data_dir / "profile"),
            headless=False,
            viewport={"width": 1280, "height": 800},
            locale="zh-CN",
        )
        self._page = self._context.pages[0] if self._context.pages else self._context.new_page()

    def login(self):
        self._page.goto(CREATOR_URL)
        print("欢迎使用抖音创作者中心上传视频")
        print("请在打开的浏览器中扫码登录抖音创作者中心")
        print("登录完成后按回车继续...")
        input()

    def upload(self, video_path, title=""):
        if not self._page:
            self.start()
            self.login()
        try:
            self._page.goto(f"{CREATOR_URL}/media/upload")
            import time as t

            t.sleep(3)
            file_input = self._page.locator("input[type=file]")
            if file_input.count() == 0:
                self._page.locator("text=上传视频").first.click(timeout=5000)
                t.sleep(1)
                file_input = self._page.locator("input[type=file]")
            file_input.set_input_files(video_path)
            print(f"文件已选择: {video_path}")
            t.sleep(5)
            if title:
                ti = self._page.locator("input[placeholder*=标题]").first()
                if ti.count() == 0:
                    ti = self._page.locator("textarea[placeholder*=标题]").first()
                if ti.count() > 0:
                    ti.fill(title)
            print("视频已上传到浏览器，请在页面上完成设置后手动发布")
            return True
        except Exception as e:
            print(f"上传失败: {e}")
            return False

    def close(self):
        if self._browser:
            self._browser.close()
        if self._playwright:
            self._playwright.stop()
        if self._context:
            self._context.close()
