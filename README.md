# dsh-ui-skin-manager

> **Status: placeholder.** 本仓库目前只有本文件。加载器与管理器仍在
> `DSH-EAC/DSH-Desktop-EAC` 内开发（v6 里程碑进行中）。
> **Status: placeholder.** This repository currently contains only this file.
> The loader and manager are still being developed inside
> `DSH-EAC/DSH-Desktop-EAC` (v6 milestone, in progress).

DSH-Desktop-EAC（EAC）的 **UI 皮肤插件加载器与管理器**。
**UI skin plugin loader and manager** for DSH-Desktop-EAC (EAC).

---

## 1. 定位 / Positioning

本仓库是 **加载器（loader）** 与 **管理器（manager）** 的实现载体。

- **加载器**：发现、校验、加载、启停皮肤包（Skin / Control / Style / Slot）。
- **管理器**：注册表、选择、绑定、启停、冲突处理、安装与卸载。
- **Loader**: discovers, validates, loads and enables/disables skin packages
  (Skin / Control / Style / Slot).
- **Manager**: registry, selection, binding, enable/disable, conflict handling,
  install and uninstall.

**边界 / Boundaries**

- 本仓库 **不是** 公共互操作协议，也不向全生态提出要求。
  It is **not** a public interoperability protocol and imposes nothing ecosystem-wide.
- 本仓库 **不** 定义"皮肤怎么写"。皮肤创作规范（UI Skin Authoring Convention）
  由本加载器私有持有，正文不在本仓库。
  Skin **authoring** rules are owned privately by this loader; their normative
  text does not live here.
- 本体（EAC 桌面壳）不承载皮肤加载逻辑；加载能力属于本仓库。
  The EAC shell does not embed skin-loading logic; that capability belongs here.

## 2. 与既有 `ui-skin` 包契约的关系 / Relation to the existing `ui-skin` contract

EAC `v6` 已落地一套内置 UI 皮肤包契约（**PR #396**，`dev` 分支）：

An in-tree built-in UI skin package contract already exists (**PR #396**, `dev`):

```text
dsh-desktop/assets/ui-skin/
├── registry.json                    # 默认包目录 + 可加载资产清单
└── system-default/
    ├── skin.json                    # 聚合包（type: skin）
    ├── control/{control.json,layout.css}
    ├── style/{style.json,tokens.css,states.css}
    └── slot/slot.json               # 区块注册表
```

- 决定与理由：`DSH-Desktop-EAC` 的 `docs/adr/0009-builtin-ui-skin-package-split.md`
  （它 supersede 了 `docs/adr/0005` 与 `docs/adr/0007`）。
- 目前 Rust 侧只做静态伺服：读取 `registry.default.directory` 一个目录 + 资产白名单
  （`tauri-shell/src/main.rs`），**没有发现、选择、启停、冲突或卸载**——
  这正是本仓库要补的部分。
- Today the Rust shell only static-serves one registry-selected directory with an
  asset whitelist. Discovery, selection, enable/disable, conflict handling and
  uninstall do not exist yet — that is the gap this repository fills.

## 3. 分发边界：示例皮肤 / Distribution boundary for bundled skins

本仓库最终将把 **加载器 + 全部版权在 EAC/AIO 的皮肤与美化** 作为内置示例一起打包
（"装一个美化包就能美化一堆地方"）。
This repository will eventually bundle **the loader plus all EAC/AIO-copyrighted
skins and beautifications** as built-in examples.

明确约束 / Explicit constraints:

- **第三方皮肤原件不复制进本仓库。** 现有 `assets/skins/` 下 10 款皮肤中，
  9 款为第三方来源（`@linxin666/*`，BSD-3-Clause，上游
  `github.com/zhu1090093659/dsh-web-ui`），1 款为 `CC-BY-NC-SA-4.0`（非商用）。
  它们如需展示，一律以**引用**方式处理，不重新分发原件。
  Third-party skin artifacts are **not** copied in. Of the 10 skins currently under
  `assets/skins/`, 9 are third-party (BSD-3-Clause) and 1 is
  `CC-BY-NC-SA-4.0` (non-commercial). Any showcase of them must **reference**,
  not redistribute.
- **每个内置示例必须随许可与署名。** 宿主现有皮肤均带 `LICENSE` + `NOTICE`
  （多来源署名链）；本仓库复制这一纪律。
  Every bundled example must ship its license and attribution, mirroring the
  existing `LICENSE` + `NOTICE` discipline.
- 本仓库开始承载可分发内容时，**必须** 附 `THIRD-PARTY-NOTICES` 与来源清单。
  A `THIRD-PARTY-NOTICES` and provenance inventory are **required** before this
  repository carries any distributable content.

## 4. 待定事项（尚未决策，勿据此写码或写规范）/ Open decisions

以下问题需由维护方定夺。**在它们定案前，本仓库不写入规范正文或接口。**
These must be settled by the maintainers first; no normative text or interface
will be written here before then.

1. **与 `.dshpack` 的关系** —— EAC 已有 schema 化的功能包格式
   （`DSH-Desktop-EAC` 的 `docs/feature-pack-spec.md` +
   `docs/schemas/feature-pack-pack.json`，具备事务、引用计数卸载、sha256、
   升级回滚与稳定错误码）。皮肤/UI 包是：
   (i) `.dshpack` 内的一种新 payload、(ii) 共享其 registry/生命周期的兄弟格式、
   还是 (iii) 真正独立的私有协议？
   Relationship to the existing `.dshpack` feature-pack format: payload type,
   sibling sharing the registry/lifecycle, or genuinely separate private protocol?
2. **格式与坐标的归属** —— 皮肤包格式属于子协议、私有 profile，还是 `.dshpack` 的载荷？
   私有坐标（`apiVersion` + `kind`）采用什么命名空间与 kind 集合？
   Format and coordinate ownership, and the private coordinate namespace / kind set.
3. **词表是否与内核对齐** —— 内核实测使用 `slot`（`<domain>.<entry>.<hole>`）、
   `[data-slot]` 锚点、CSS Modules + `--dsw-*` token，其 `data-state` 闭集为
   `done | warning | ongoing | error | idle`。是否改用内核词表，或提供规范化的适配层 + 映射表？
   Align with the kernel vocabulary, or publish a normative adapter + mapping table?
4. **分发方式** —— 独立库、整合包、市场条目，还是同时？
   Distribution form: standalone library, pack, market entry, or a combination.

## 5. 相关仓库 / Related repositories

| 仓库 | 关系 |
| --- | --- |
| [`DSH-EAC/DSH-Desktop-EAC`](https://github.com/DSH-EAC/DSH-Desktop-EAC) | 宿主（EAC 桌面壳）；当前 v6 开发中 |
| [`DSH-EAC/DSH-Desktop-EAC-UI-Skin-Authoring-Convention`](https://github.com/DSH-EAC/DSH-Desktop-EAC-UI-Skin-Authoring-Convention) | 皮肤创作公约（Draft v0.11），加载器私有持有 |

---

> 本文件为占位内容，用于主张仓库名与记录边界。
> Placeholder content: asserts the repository name and records boundaries.

**许可 / License:** 待定（TBD）。
