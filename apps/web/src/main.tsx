import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ArticleDetail, ArticleSummary, RunSummary } from "@model-radar/contracts";
import { getArticle, listArticles, listRuns, startRun } from "./api";
import "./styles.css";

const capabilityLabels: Record<string, string> = { reasoning: "推理", tool_use: "工具调用", context: "上下文", multimodal: "多模态", coding: "编程", speed_cost: "速度与成本", reliability: "可靠性", safety: "安全" };
const opportunityLabels: Record<string, string> = { agent: "Agent", rag: "RAG", developer_tools: "开发工具", automation: "流程自动化", customer_support: "客服", content_creation: "内容生成", data_analysis: "数据分析" };
const releaseKindLabels: Record<string, string> = { new_model: "新模型", model_update: "版本更新", model_capability: "专属能力", model_deprecation: "弃用 / 退役" };

type Route = { name: "home" } | { name: "article"; slug: string } | { name: "admin" };

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  if (hash === "/admin") return { name: "admin" };
  const article = hash.match(/^\/articles\/(.+)$/);
  return article ? { name: "article", slug: decodeURIComponent(article[1]) } : { name: "home" };
}

function date(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

function Header() {
  return <header className="site-header"><a className="brand" href="#/">MODEL <em>RADAR</em></a><nav><a href="#/">更新</a></nav></header>;
}

function ArticleCard({ article }: { article: ArticleSummary }) {
  return <a className="article-card" href={`#/articles/${encodeURIComponent(article.slug)}`}>
    <div className="eyebrow"><span>{article.provider}</span><time>{date(article.publishedAt)}</time></div>
    <h2>{article.title}</h2><p>{article.summary}</p><div className="article-tags"><span className="tag kind">{releaseKindLabels[article.releaseKind]}</span>{article.models.map((item) => <span className="tag model" key={item}>{item}</span>)}</div><span className="read-more">阅读推演 →</span>
  </a>;
}

function Home() {
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [provider, setProvider] = useState("all");
  const [model, setModel] = useState("all");
  const [tag, setTag] = useState("all");
  const [error, setError] = useState("");
  const models = useMemo(() => [...new Set(articles.flatMap((article) => article.models))].sort(), [articles]);
  const tags = useMemo(() => [...new Set(articles.flatMap((article) => [...article.capabilityTags, ...article.opportunityTags]))].sort(), [articles]);
  const displayed = useMemo(() => articles.filter((item) => (provider === "all" || item.provider === provider)
    && (model === "all" || item.models.includes(model))
    && (tag === "all" || item.capabilityTags.includes(tag as never) || item.opportunityTags.includes(tag as never))), [articles, provider, model, tag]);
  useEffect(() => { listArticles().then(setArticles).catch((err: Error) => setError(err.message)); }, []);
  return <main>
    <section className="hero"><p className="kicker">DAILY MODEL INTELLIGENCE</p><h1>把模型更新，<br /><i>译成产品机会。</i></h1><p>每天追踪官方模型版本变化，用 AI 推演下一代应用功能。事实来自原文，机会来自有边界的推断。</p></section>
    <section className="feed"><div className="feed-top"><h2>最新更新</h2><div className="filters">{["all", "openai", "anthropic"].map((item) => <button className={provider === item ? "active" : ""} onClick={() => setProvider(item)} key={item}>{item === "all" ? "全部" : item}</button>)}</div></div><div className="select-filters"><label>模型<select value={model} onChange={(event) => setModel(event.target.value)}><option value="all">全部模型</option>{models.map((item) => <option key={item}>{item}</option>)}</select></label><label>能力 / 机会<select value={tag} onChange={(event) => setTag(event.target.value)}><option value="all">全部标签</option>{tags.map((item) => <option key={item} value={item}>{capabilityLabels[item] ?? opportunityLabels[item] ?? item}</option>)}</select></label></div>
      {error && <p className="error">{error}</p>}
      {!error && displayed.length === 0 && <div className="empty"><strong>还没有文章。</strong><span>到「管理」页运行首次抓取，模型更新会在通过校验后自动公开。</span></div>}
      <div className="grid">{displayed.map((article) => <ArticleCard key={article.slug} article={article} />)}</div>
    </section>
  </main>;
}

function Article({ slug }: { slug: string }) {
  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { getArticle(slug).then(setArticle).catch((err: Error) => setError(err.message)); }, [slug]);
  if (error) return <main className="detail"><p className="error">{error}</p><a href="#/">返回首页</a></main>;
  if (!article) return <main className="detail">加载中…</main>;
  return <main className="detail"><a className="back" href="#/">← 全部更新</a><p className="kicker">{article.provider} · {date(article.publishedAt)}</p><h1>{article.title}</h1><p className="lede">{article.summary}</p><div className="article-tags detail-tags"><span className="tag kind">{releaseKindLabels[article.releaseKind]}</span>{article.models.map((item) => <span className="tag model" key={item}>{item}</span>)}{article.capabilityTags.map((item) => <span className="tag" key={item}>{capabilityLabels[item]}</span>)}{article.opportunityTags.map((item) => <span className="tag" key={item}>{opportunityLabels[item]}</span>)}</div>
    <section><a className="source-link" href={article.sourceUrl} target="_blank" rel="noreferrer">查看官方原文 ↗</a></section>
    <section><h2>变化要点</h2><ul>{article.analysis.keyChanges.map((item) => <li key={item}>{item}</li>)}</ul></section>
    <section className="inference"><p className="kicker">AI INFERENCE · 非官方承诺</p><h2>可能带来的应用功能</h2>{article.analysis.potentialFeatures.map((feature) => <article className="feature" key={feature.name}><div><h3>{feature.name}</h3><span className={`confidence ${feature.confidence}`}>{feature.confidence} confidence</span></div><p><b>使用场景：</b>{feature.scenario}</p><p><b>推演依据：</b>{feature.rationale}</p><p><b>实现前提：</b>{feature.prerequisites.join("、")}</p></article>)}</section>
    <section><h2>边界与注意事项</h2><ul>{article.analysis.caveats.map((item) => <li key={item}>{item}</li>)}</ul></section>
  </main>;
}

function Admin() {
  const [token, setToken] = useState(() => sessionStorage.getItem("model-radar-admin-token") ?? "");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const load = async () => {
    if (!token) return;
    try { setRuns(await listRuns(token)); setError(""); sessionStorage.setItem("model-radar-admin-token", token); } catch (err) { setError((err as Error).message); }
  };
  useEffect(() => { void load(); }, []);
  const run = async () => {
    setRunning(true); setError("");
    try { await startRun(token); await load(); } catch (err) { setError((err as Error).message); } finally { setRunning(false); }
  };
  return <main className="admin"><p className="kicker">PRIVATE LOCAL CONSOLE</p><h1>管理运行</h1><p>使用本地 <code>ADMIN_TOKEN</code> 查看运行记录或手动触发一次抓取。</p>
    <div className="token"><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN" /><button onClick={() => void load()}>连接</button></div>
    <button className="run" disabled={!token || running} onClick={() => void run()}>{running ? "正在抓取与推演…" : "运行一次更新"}</button>{error && <p className="error">{error}</p>}
    <div className="runs">{runs.map((run) => <article key={run.id}><div><strong>#{run.id} · {run.status}</strong><time>{date(run.startedAt)}</time></div><p>发现 {run.discoveredCount} 条，发布 {run.publishedCount} 篇</p>{run.error && <pre>{run.error}</pre>}</article>)}</div>
  </main>;
}

function App() {
  const [route, setRoute] = useState(parseRoute());
  useEffect(() => { const listener = () => setRoute(parseRoute()); window.addEventListener("hashchange", listener); return () => window.removeEventListener("hashchange", listener); }, []);
  return <><Header />{route.name === "home" ? <Home /> : route.name === "article" ? <Article slug={route.slug} /> : <Admin />}<footer>MODEL RADAR · 官方事实与 AI 推演分层呈现</footer></>;
}

createRoot(document.getElementById("root")!).render(<App />);
