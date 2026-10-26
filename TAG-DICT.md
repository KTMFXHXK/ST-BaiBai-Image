# 标签中英词典（随插件部署的数据）

本目录 `tag-data/` 是「编辑提示词」里中文对照/查词功能用的静态数据。它只被读取，
**不参与任何提示词写回、保存或 NovelAI 请求组装**。代码入口见 `src/i18n/tagDictionary.ts`。

## 数据来源与致谢

| 项 | 值 |
| --- | --- |
| 原始数据 | [`ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table`](https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table)（`tag.sqlite`） |
| 上游直链 | `https://raw.githubusercontent.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/main/tag.sqlite` |
| NovelAI 专有标签参考 | <https://docs.novelai.net/en/image/tags/> |
| 分片格式与生成流程 | 取自本地工程 `NovelAI创作工坊` 的 `public/tag-data`（其 `data/README.md` 说明：ffdkj 每日更新的中英对照库，收录 `post_count >= 10` 的 Tag，并与 `novelai-v45-tags.json` 合并） |
| 本插件内清单生成时间 | `2026-10-22T15:53:00.816Z`（`manifest.json` 的 `generatedAt`） |

许可情况：发布前已核对上游数据仓库，当前提供 MIT 许可证。随附原文见
[`tag-data/LICENSE.ffdkj.txt`](tag-data/LICENSE.ffdkj.txt)，保留其原作者版权声明。
本说明只确认该词典来源的许可，不对原插件或其他第三方内容另行声明许可证。

## 条目数与体积（本目录实测）

- 词条总数 **334,356** 条，分类统计：普通 53,367 / 画师 154,943 / 作品 20,302 / 角色 104,857 / 元数据 747 / NAI V4.5 140。
- 实际随插件部署 **1,818 个文件、33,368,766 字节（约 31.82 MB）**：
  - `manifest.json` 191,421 字节（sha256 `ddeab3f19b6ce8d68396ef7a0eb70ef31d7160d7a4ef11d0bff00048bd2be6d2`）
  - `shards/` 1,561 个英文分片，15.82 MB
  - `zh-shards/` 256 个中文分片，15.82 MB
- 参考工程原始 `tag-data` 共 2,987 个文件、79,985,117 字节（约 76.3 MB）。**没有**搬过来的部分：
  `character-search-shards/`（13.93 MB）、`character-search-records.json`（6.0 MB）、
  `artist-pages/` 与 `artist-name-pages/`（各 5.86 MB）、`character-pages/` 与 `character-name-pages/`（各 6.4 MB）。
  这些是「按分类浏览整库/中文角色反查」用的，本功能只需要「查词 → 释义」，不需要它们。

## 加载与缓存策略

- `manifest.json` 每个插件版本取一次（URL 带 `?v=<插件版本>`，可被浏览器长缓存），约 191 KB。
- 分片**按需**加载：只有真正查某个前缀时才取那一片（通常 5–20 KB），URL 带 `?v=<generatedAt>`
  以便内容变了自动失效；同一分片在一次会话里只会下载一次（内存里缓存 Promise）。
- 路由规则：
  - 英文查询取前两个字符（不足补空格）作键，查 `shards`；
  - 中文查询取首字 `codePoint % 256` 的两位十六进制作键，查 `chineseShards`；
  - 单字符英文查询直接用 `manifest.popular` 里的热门索引，不额外下载。
- 清缓存：`clearDictionaryCache()`（代际计数会让在途旧请求的结果作废）。

## 查词规则（只用于查询，不改提示词）

- 归一化只作用于比较用的副本：下划线 ↔ 空格、折叠空白、转小写；`{}`/`[]`/`1.2::…::`/`(tag:1.2)`/`(tag)`/`artist:` 前缀在分词阶段剥掉，仅用于查词。
- **自动显示释义必须是精确匹配**：英文名归一后与标签完全相同、且中文非空才算「词典释义」；
  前缀搜索命中的只是「建议」，界面上标「词典」但必须由用户点「插入」才写入字段。
- **查词只支持前缀**，不做包含匹配：查 `初音` 能查到 `初音未来`，查 `未来` 查不到。
  所以中文输入要从词条开头写；这也是为了不因为一个字就去读整库（包含匹配只能靠
  遍历全部 256 个中文分片，代价与收益不匹配，已明确不做）。
- 词典里没有的标签显示「暂无释义」，可由用户手动触发 AI 翻译（结果标「AI 翻译」，
  仅本地缓存、只用于显示，不进提示词）。

## 更新数据

在 `NovelAI创作工坊` 里重新生成 `public/tag-data`，然后把 `manifest.json`、`shards/`、`zh-shards/`
三个部分覆盖到本目录即可；本插件的读取代码不需要改（分片格式与路由键未变）。
