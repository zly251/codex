from duckduckgo_search import DDGS

class WebSearch:
    def __init__(self):
        self.ddgs = DDGS()

    def search(self, query, max_results=5):
        try:
            results = list(self.ddgs.text(query, max_results=max_results))
            return [{"title": r["title"], "url": r["href"], "body": r["body"]} for r in results]
        except Exception as e:
            return [{"error": str(e)}]

    def search_news(self, query, max_results=5):
        try:
            results = list(self.ddgs.news(query, max_results=max_results))
            return [{"title": r["title"], "url": r["url"], "body": r["body"]} for r in results]
        except Exception as e:
            return [{"error": str(e)}]
