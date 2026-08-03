// scrapers 模块统一接口定义
// 所有招聘网站爬虫必须实现此接口

/**
 * 职位标准数据结构
 * 无论来自哪个网站，最终都输出此格式
 */
export interface JobPosting {
  /** 职位标题 */
  title: string;
  /** 薪资范围原文，如 "15-20K·14薪" */
  salary: string;
  /** 公司名称 */
  company: string;
  /** 工作城市 */
  city: string;
  /** 原始详情页 URL */
  url: string;
  /** 来源网站标识，如 "zhipin" */
  source: string;
  /** 职位描述（纯文本） */
  description: string;
  /** 任职要求（纯文本） */
  requirements: string;
  /** 技术关键词列表 */
  technologies: string[];
  /** 学历要求 */
  education: string;
  /** 经验要求 */
  experience: string;
  /** 发布时间/更新时间 */
  updatedAt: string;
}

/**
 * 搜索配置
 * 定义一次搜索任务的所有参数
 */
export interface SearchConfig {
  /** 搜索关键词，如 "C++ 开发" */
  keywords: string;
  /** 目标城市 */
  city: string;
  /** 最多抓取职位数 */
  maxJobs: number;
  /** 分页延迟（毫秒），防反爬 */
  pageDelay: number;
}

/**
 * 搜索结果摘要
 */
export interface SearchResult {
  /** 当前页职位链接列表 */
  jobs: { url: string; title: string }[];
  /** 是否有下一页 */
  hasNext: boolean;
}

/**
 * 爬虫统一接口
 * 每个招聘网站实现各自版本
 */
export interface JobScraper {
  /** 爬虫标识名称 */
  readonly name: string;

  /**
   * 判断当前爬虫是否能处理此 URL
   * 用于自动路由
   */
  supports(url: string): boolean;

  /**
   * 搜索职位，返回列表页中的所有职位链接
   * @param config 搜索配置
   * @param page   Puppeteer Page 实例
   */
  search(config: SearchConfig, page: any): Promise<SearchResult>;

  /**
   * 获取某个职位的详细页面数据
   * @param url  职位详情页 URL
   * @param page Puppeteer Page 实例
   */
  getDetail(url: string, page: any): Promise<JobPosting | null>;
}
