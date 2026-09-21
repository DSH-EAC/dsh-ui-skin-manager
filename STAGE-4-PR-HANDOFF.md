## 目的 Purpose

实现 manager 测试宿主中的运行时 adapter、按槽位隔离、dsh client 公开 API 适配和可操作诊断错误边界。该阶段不修改 DSH-Desktop-EAC 默认生产路径。

## 架构与范围 Architecture & Scope

- `src/runtime/slots/host-slots.ts`：基于 HostProfile 的 typed slot 校验、组件挂载、style replacement、AbortSignal、generation guard 与 EffectLedger 清理。
- `src/runtime/theme/theme-registry.ts`：按 owner/generation 管理 theme register/override/dispose。
- `src/runtime/dsh-client/adapter.ts`：显式 versioned mapping，暴露受限的 `ctx.theme` 与 `ctx.slots`，以 ledger 接管 Cordis-compatible disposer。
- `src/runtime/error-boundary/runtime-supervisor.ts`：同步 throw、Promise rejection 的 per-slot fault 转换、稳定错误 UI action surface 与诊断脱敏。
- `test/runtime/adapters.test.ts`：运行时行为及 dsh `0.1.5-rc.2`、`0.1.6-alpha.2` typed fixture 覆盖。
- `package.json`：将 runtime 子目录测试加入默认 test script。

未接入 EAC、Tauri、WebView 或外部依赖；未修改 manager/default release artifact。

## 风险与兼容 Risks & Compatibility

- adapter 只接受精确 `slot/kind/scope/capability`，不会通过名称相似或运行时 cast 放宽兼容。
- 组件效果必须通过 `EffectLedger` 登记；dispose 逆序且幂等。style 节点、theme、slot registration、listener/timer 等均可纳入 ledger。
- generation guard 阻止旧 context 在新 generation 后继续写入 UI。
- 第三方运行期错误转换为稳定 fault；诊断消息会脱敏路径及 credential-like 字段。
- manager contract 仍为 preview；dsh fixture 只验证显式 mapping，不声称已完成官方 dsh 类型编译矩阵。

## 验证 Verification

- [x] RED：`node --experimental-strip-types --test --test-concurrency=1 test/runtime/adapters.test.ts` 在实现前因 `src/index.ts` 缺失 `DshClientRuntimeAdapter` 导出而失败。
- [x] GREEN：`npm test`：26 passed, 0 failed。
- [x] `npm run format:check`：passed。
- [x] `git diff --check`：passed。
- [x] 本次 verifier 修复新增 3 条并发回归测试：旧 context UI 写入被忽略、旧 mount 不得夺回 current generation、旧 mount 失败不污染新 generation error UI。
- [x] 本次修复后的 `npm run format:check`：passed。
- [x] 本次修复后的 `git diff --check`：passed。
- [ ] 未运行本地 compile/build/typecheck/test，遵循 operator 明确限制，CI remains authority。
- [ ] 未提供真实 WebView 截图/录屏；本阶段只修改 manager 测试宿主，不具备 EAC UI 启动路径。

## Verifier follow-up

- 修复 `replaceStyle` generation/abort guard：非 current 或 aborted context 在副作用执行前直接忽略写入。
- mount 开始时以单调规则登记 slot 的最高 generation，旧异步 mount 完成后不会覆盖较新的 current。
- 旧 generation 的失败仍会清理并向调用方传播，但不会触发宿主错误 UI；当前 generation 的错误 UI 行为保持不变。
- 本地未执行测试、编译或 typecheck；上述行为由新增回归测试覆盖，最终执行需交由 CI。


## 配置与迁移 Configuration & Migration

无需迁移。runtime API 通过 manager `src/index.ts` 导出；现有消费者行为不变，EAC 尚未启用该旁路。

## 回退方式 Rollback

删除或回退 `stage-4-runtime-adapters` 分支即可恢复阶段 3 manager core。由于没有写入用户持久化状态、没有修改 EAC 生产路径、没有新增依赖，回退不需要数据迁移。

## 交付信息 Delivery

- Branch: `stage-4-runtime-adapters`
- Base: `stage-3-manager-core`
- Commit: `67cf896` (`docs: refresh stage 4 CI handoff`)
- Publication: readable branch pushed to `origin/stage-4-runtime-adapters`; CI remains the authority for test/type/build verification; no PR or release created by this task
