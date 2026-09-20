const assert = require("assert");
const test = require("node:test");
const engine = require("../js/engine");

function advance(store, ticks) {
  for (let i = 0; i < ticks; i += 1) {
    engine.tick(store);
  }
}

test("默认工况保持稳定，核心量位于正常窗口", () => {
  const store = engine.createStore();
  advance(store, 30);

  assert.strictEqual(store.state.phase, "normal");
  assert.strictEqual(store.state.stable, true);
  assert.ok(Math.abs(store.state.reactor.temperature - 180) < 0.1);
  assert.ok(Math.abs(store.state.reactor.pressure - 1.45) < 0.01);
  assert.ok(Math.abs(store.state.segments.product.current.purity - 99.4) < 0.1);
});

test("阀门影响先停留在进料段，随后才到达预热和反应器", () => {
  const store = engine.createStore();
  engine.applyAction(store, "setValveA", 0.9);
  engine.applyAction(store, "setValveB", 0.18);

  engine.tick(store);
  assert.strictEqual(store.state.segments.aFeed.current.aFlow, 50);
  assert.strictEqual(store.state.segments.preheater.current.aFlow, 50);

  advance(store, 4);
  assert.ok(store.state.segments.aFeed.current.aFlow > 80);
  assert.strictEqual(store.state.segments.preheater.current.aFlow, 50);

  advance(store, 6);
  assert.ok(store.state.segments.preheater.current.aFlow > 80);
});

test("备用冷却能力不足时先预警，再触发保护并保持紧急冷却", () => {
  const store = engine.createStore();
  engine.applyAction(store, "switchCooling", "backup");

  let sawWarning = false;
  let sawProtection = false;
  for (let i = 0; i < 40; i += 1) {
    engine.tick(store);
    sawWarning = sawWarning || store.state.phase === "warning";
    sawProtection = sawProtection || store.state.phase === "protection";
  }

  assert.ok(sawWarning);
  assert.ok(sawProtection);
  assert.strictEqual(store.state.phase, "protection");
  assert.strictEqual(store.state.protection.coolingForced, true);
});

test("严重错误配比会触发紧急停车，恢复后可回到稳定生产", () => {
  const store = engine.createStore();
  engine.applyAction(store, "setValveA", 1);
  engine.applyAction(store, "setValveB", 0.05);

  for (let i = 0; i < 20 && store.state.phase !== "esd"; i += 1) {
    engine.tick(store);
  }
  assert.strictEqual(store.state.phase, "esd");

  for (let i = 0; i < 30; i += 1) {
    engine.tick(store);
  }
  const recovery = engine.beginRecovery(store);
  assert.strictEqual(recovery.ok, true);

  for (let i = 0; i < 130 && store.state.phase !== "normal"; i += 1) {
    engine.tick(store);
  }

  assert.strictEqual(store.state.phase, "normal");
  advance(store, 20);
  assert.strictEqual(store.state.stable, true);
  assert.ok(store.state.reactor.pressure >= 1.3);
  assert.ok(store.state.segments.product.current.purity >= 98.5);
});

test("稳定点可生成方案，失败尝试不会覆盖最后有效配置", () => {
  const store = engine.createStore();
  advance(store, 15);
  const lastValidBefore = { ...store.lastValid };

  const branch = engine.createPlanAtStablePoint(store, "危险配比试验");
  assert.strictEqual(branch.ok, true);

  engine.applyAction(store, "setValveA", 1);
  engine.applyAction(store, "setValveB", 0.05);
  for (let i = 0; i < 25 && store.state.phase !== "esd"; i += 1) {
    engine.tick(store);
  }

  assert.strictEqual(store.state.phase, "esd");
  assert.deepStrictEqual(store.lastValid, lastValidBefore);

  const abandon = engine.abandonActiveAttempt(store);
  assert.strictEqual(abandon.ok, true);
  assert.strictEqual(store.state.phase, "normal");
  assert.strictEqual(store.state.controls.valveA, lastValidBefore.valveA);
  assert.strictEqual(store.state.controls.valveB, lastValidBefore.valveB);
  assert.ok(store.plans.some((plan) => plan.status === "failed"));
});

test("非稳定点不能生成新方案", () => {
  const store = engine.createStore();
  engine.applyAction(store, "setValveA", 0.9);
  engine.tick(store);

  const result = engine.createPlanAtStablePoint(store);
  assert.strictEqual(result.ok, false);
});
