// 连续化工反应装置异常工况处置推演 —— 仿真内核（无 DOM 依赖，可被 Node 测试引用）
// 工艺流程：A/B 进料 -> 混合管线 -> 反应器(CSTR) -> 产品管线 -> 产品罐
// 采用 1s 离散步进，进料扰动与产品质量均沿物料流通过延迟队列传播，不瞬时出现。

const DT = 1;

const CFG = {
  // 管道传播延迟（秒）
  feedDelay: 10,
  productDelay: 20,
  // 反应器
  V: 20, // 有效容积 m3
  Tref: 363.15, // 动力学参考温度 90°C
  kRef: 0.093, // 参考温度下反应速率常数 1/min（额定点转化率标定 ~0.70）
  Ea: 52000, // 活化能 J/mol
  R: 8.314,
  dTad: 150, // 绝热温升 K（满转化）
  Tf: 303.15, // 进料温度 30°C
  CpFlow: 100, // kW·s/K（进料携带与热容合并系数）
  Fnom: 40, // 额定总进料 m3/h
  // 冷却
  TjacketNom: 328.15, // 55°C 冷却介质闭环温度
  Kmain: 142, // 主冷却回路 kW/K（满负荷 90°C 留有稳定裕度，温升超过 ~110°C 后移热不足）
  Kbackup: 88, // 备用回路（仅能维持约 85% 负荷，超量工况下移热不足）
  switchSeconds: 30, // 切换过渡时间
  // 执行器速率（每秒变化量）
  valveRate: 0.05,
  loadRate: 0.02,
  // 保护
  T_warn: 100,
  T_protect: 108,
  T_trip: 120,
  P_warn: 2.0,
  P_protect: 2.3,
  P_trip: 3.5,
  purityWarn: 0.92,
  purityBad: 0.85,
  protectLoadCap: 0.7,
  stableSeconds: 30,
  stableTolT: 1.0,
  stableTolP: 0.05,
  stableTolX: 0.01,
  // 恢复
  recoveryCooldownT: 70,
  recoveryStableT: 95,
  recoveryStableSeconds: 20,
  recoveryStablePurity: 0.9,
  recoveryRampRate: 0.01,
  recoveryRampTarget: 0.6,
};

const PHASES = ['NORMAL', 'WARNING', 'PROTECTION', 'TRIP', 'RECOVERY', 'ABORTED'];
const PHASE_LABEL = {
  NORMAL: '正常运行',
  WARNING: '预警',
  PROTECTION: '保护介入',
  TRIP: '紧急停车',
  RECOVERY: '恢复生产',
  ABORTED: '恢复中止',
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function nominalSnapshot() {
  return {
    valveA: 1,
    valveB: 1,
    loadTarget: 1,
    coolingTarget: 1,
    circuit: 'main',
  };
}

class Simulator {
  constructor(now = 0, seed = null) {
    this.now = now;
    const s = seed ? structuredClone(seed) : null;
    this.cfg = CFG;
    if (s) {
      this.phase = s.phase;
      this.flags = s.flags;
      this.recovery = s.recovery;
      this.valveA = s.valveA;
      this.valveB = s.valveB;
      this.loadTarget = s.loadTarget;
      this.loadActual = s.loadActual;
      this.coolingTarget = s.coolingTarget;
      this.coolActual = s.coolActual;
      this.circuit = s.circuit;
      this.switching = s.switching;
      this.T = s.T;
      this.Tj = s.Tj;
      this.P = s.P;
      this.x = s.x;
      this.purity = s.purity;
      this.feedQueue = s.feedQueue;
      this.productQueue = s.productQueue;
      this.events = [];
      this.series = [];
      this.stableNormalSeconds = 0;
      this.reliefOpen = false;
    } else {
      this.phase = 'NORMAL';
      this.flags = { hiT: false, hiP: false, purityLow: false, purityBad: false };
      this.recovery = null;
      this.valveA = 1;
      this.valveB = 1;
      this.loadTarget = 1;
      this.loadActual = 1;
      this.coolingTarget = 1;
      this.coolActual = 1;
      this.circuit = 'main';
      this.switching = null;
      this.T = 90;
      this.Tj = 83.6;
      this.P = 1.1;
      this.x = 0.70;
      this.purity = 0.97;
      // 队列用稳态料流预热，避免“凭空启动”瞬态
      this.feedQueue = Array.from({ length: CFG.feedDelay }, () => ({ ratio: 1, f: CFG.Fnom }));
      this.productQueue = Array.from({ length: CFG.productDelay }, () => ({ x: 0.7, ratio: 1 }));
      this.events = [];
      this.series = [];
      this.stableNormalSeconds = 0;
      this.reliefOpen = false;
      this.log('INFO', '装置处于额定稳态，推演开始');
    }
  }

  log(level, message) {
    this.events.push({ t: this.now, level, message });
    if (this.events.length > 500) this.events.shift();
  }

  // ---------- 操作人员动作 ----------

  setValve(name, value) {
    if (this.phase === 'TRIP' || this.phase === 'ABORTED') {
      return { ok: false, reason: '紧急停车状态下进料阀已联锁关闭' };
    }
    if (this.phase === 'RECOVERY') {
      return { ok: false, reason: '恢复生产按引导程序进行，手动进料已锁定' };
    }
    // 允许误操作开至 125%（DCS 阀位上限），过量进料是飞温的典型诱因
    value = clamp(value, 0, 1.25);
    if (name === 'A') {
      this.valveA = value;
      this.log('OP', `操作人员调整 A 进料阀开度至 ${(value * 100).toFixed(0)}%`);
    } else {
      this.valveB = value;
      this.log('OP', `操作人员调整 B 进料阀开度至 ${(value * 100).toFixed(0)}%`);
    }
    return { ok: true };
  }

  setLoad(value) {
    if (this.phase === 'TRIP' || this.phase === 'ABORTED') {
      return { ok: false, reason: '紧急停车状态下不能提升负荷' };
    }
    if (this.phase === 'RECOVERY') {
      return { ok: false, reason: '恢复阶段请使用恢复引导提升负荷' };
    }
    if (this.phase === 'PROTECTION') value = Math.min(value, CFG.protectLoadCap);
    this.loadTarget = clamp(value, 0, 1);
    this.log('OP', `操作人员设定生产负荷至 ${(this.loadTarget * 100).toFixed(0)}%`);
    return { ok: true };
  }

  reduceLoad() {
    if (this.phase === 'TRIP' || this.phase === 'ABORTED') {
      return { ok: false, reason: '装置已停车' };
    }
    if (this.phase === 'RECOVERY') {
      return { ok: false, reason: '恢复阶段请使用恢复引导' };
    }
    const cap = this.phase === 'PROTECTION' ? CFG.protectLoadCap : 1;
    this.loadTarget = clamp(Math.min(this.loadTarget - 0.3, cap), 0, 1);
    this.log('OP', `操作人员降低负荷，目标 ${(this.loadTarget * 100).toFixed(0)}%`);
    return { ok: true };
  }

  setCooling(value) {
    if (this.phase === 'TRIP' || this.phase === 'ABORTED') {
      return { ok: false, reason: '停车状态下急冷泵自动投用，无需手动设置' };
    }
    if (this.phase === 'RECOVERY') {
      return { ok: false, reason: '恢复阶段冷却由引导程序控制' };
    }
    value = clamp(value, 0, 1.25);
    this.coolingTarget = value;
    this.log('OP', `操作人员设定冷却阀开度至 ${(value * 100).toFixed(0)}%`);
    return { ok: true };
  }

  switchCooling(target) {
    if (this.phase === 'TRIP' || this.phase === 'ABORTED') {
      return { ok: false, reason: '停车状态下冷却回路由急冷程序接管' };
    }
    if (this.phase === 'RECOVERY') {
      return { ok: false, reason: '恢复阶段冷却由引导程序控制' };
    }
    if (target !== 'main' && target !== 'backup') {
      return { ok: false, reason: '未知冷却回路' };
    }
    if (this.switching) return { ok: false, reason: '冷却回路正在切换中' };
    if (this.circuit === target) return { ok: false, reason: `已处于${target === 'main' ? '主' : '备用'}冷却回路` };
    this.switching = { from: this.circuit, to: target, elapsed: 0 };
    this.log('OP', `操作人员将冷却回路由${this.circuit === 'main' ? '主回路' : '备用回路'}切换至${target === 'main' ? '主回路' : '备用回路'}`);
    return { ok: true };
  }

  manualTrip() {
    if (this.phase === 'TRIP' || this.phase === 'ABORTED') {
      return { ok: false, reason: '装置已处于停车状态' };
    }
    this.enterTrip('操作人员判断风险不可控，手动触发紧急停车');
    return { ok: true };
  }

  // ---------- 恢复引导 ----------

  beginRecovery() {
    if (this.phase !== 'TRIP' && this.phase !== 'ABORTED') {
      return { ok: false, reason: '只有停车后才能启动恢复程序' };
    }
    this.phase = 'RECOVERY';
    this.recovery = { stage: 1, stableSeconds: 0 };
    this.coolingTarget = 1;
    this.log('OP', '操作人员启动恢复生产引导程序（阶段1：降温置换）');
    return { ok: true };
  }

  acknowledgeStage() {
    if (this.phase !== 'RECOVERY') return { ok: false, reason: '当前不在恢复程序中' };
    const r = this.recovery;
    if (r.stage === 1) {
      if (this.T >= CFG.recoveryCooldownT) {
        return { ok: false, reason: `反应温度 ${this.T.toFixed(1)}°C 未降至 ${CFG.recoveryCooldownT}°C 以下，不能引料` };
      }
      r.stage = 2;
      r.stableSeconds = 0;
      this.log('OP', '阶段2：按额定 20% 低负荷引料，观察温升');
      return { ok: true };
    }
    if (r.stage === 2) {
      if (!this.recoveryStage2Ready()) {
        return { ok: false, reason: '低负荷工况尚未稳定（温度/压力/纯度需持续达标）' };
      }
      r.stage = 3;
      r.stableSeconds = 0;
      this.log('OP', '阶段3：按速率提升负荷至 60% 额定值');
      return { ok: true };
    }
    return { ok: false, reason: '当前阶段无待确认项' };
  }

  abortRecovery(reason = '操作人员中止恢复程序') {
    if (this.phase !== 'RECOVERY') return { ok: false, reason: '当前不在恢复程序中' };
    this.enterTrip(reason, true);
    return { ok: true };
  }

  recoveryStage2Ready() {
    return (
      this.recovery.stableSeconds >= CFG.recoveryStableSeconds &&
      this.T < CFG.recoveryStableT &&
      this.P < CFG.P_warn &&
      this.purity >= CFG.recoveryStablePurity
    );
  }

  // ---------- 物理推进 ----------

  step() {
    // 每个仿真秒分 2 个子步，缓解温升刚度
    for (let sub = 0; sub < 2; sub++) this.advance(DT / 2);
    this.now += DT;
    this.judgePhase();
    this.updateStableCounter();
    this.series.push({
      t: this.now,
      T: this.T,
      P: this.P,
      x: this.x,
      purity: this.purity,
      load: this.loadActual,
      cool: this.coolActual,
      avail: this.coolingAvailability(),
      phase: this.phase,
    });
    if (this.series.length > 3600) this.series.shift();
    return this.snapshot();
  }

  advance(dt) {
    this.advanceActuators(dt);

    // 进料：阀开度 + 生产负荷决定流量；配比偏差进入混合管线，延迟后才到反应器
    // total 反映两股进料之和，过量阀开度会增加实际入料热负荷
    let ratio = this.valveA / Math.max(this.valveB, 0.02);
    let feedFactor = this.loadActual * ((this.valveA + this.valveB) / 2);
    if (this.phase === 'TRIP' || this.phase === 'ABORTED') {
      ratio = 1;
      feedFactor = 0;
    }
    if (this.phase === 'RECOVERY' && this.recovery.stage === 1) feedFactor = 0;
    const fTotal = CFG.Fnom * feedFactor;
    this.feedQueue.push({ ratio, f: fTotal });
    if (this.feedQueue.length > CFG.feedDelay) this.feedQueue.shift();
    while (this.feedQueue.length > CFG.feedDelay) this.feedQueue.shift();

    // 反应器出口流量（假定体积恒定，出料=进料）
    const inlet = this.feedQueue[0] || { ratio: 1, f: 0 };

    // 反应动力学（阿伦尼乌斯，以 90°C 为参考）
    const TK = this.T + 273.15;
    // A 过量时入口 A 浓度升高，按质量作用定律近似提高表观速率（最多 +45%）
    const concentrationGain = clamp((this.valveA / Math.max(this.valveB, 0.02) + 1) / 2, 1, 1.45);
    const kMin =
      CFG.kRef *
      concentrationGain *
      Math.exp((-CFG.Ea / CFG.R) * (1 / TK - 1 / CFG.Tref));
    const tau = CFG.V / Math.max(inlet.f, 1e-6) * 60; // min
    const Da = kMin * tau;
    // A 为限量组分、B 过量时 A 可近乎完全转化（x 升高、放热增大）；
    // B 为限量组分时 A 无法全部反应，转化率受 ratio 限制
    const limit = clamp(inlet.ratio >= 1 ? 0.97 : inlet.ratio, 0, 1);
    const xTarget = inlet.f <= 0.01 ? 0 : clamp(Da / (1 + Da), 0, limit);
    // CSTR 转化率随停留时间动态接近稳态目标
    const xTau = Math.max(CFG.V / Math.max(inlet.f, 1e-6) * 60, 5);
    this.x += (xTarget - this.x) * Math.min(1, dt / (xTau / 4));

    // 放热：进料热功率 × 绝热温升 × 转化率（Q = F·Cp·ΔTad·x）
    const fFrac = clamp(inlet.f / CFG.Fnom, 0, 1.2);
    const Qgen = CFG.CpFlow * CFG.dTad * fFrac * this.x;

    // 移热：冷却阀开度 × 回路可用度（切换期间衰减）
    const kCircuit = this.circuit === 'main' ? CFG.Kmain : CFG.Kbackup;
    const avail = this.coolingAvailability();
    const coolFrac = this.phase === 'TRIP' || this.phase === 'ABORTED' ? 1 : this.coolActual * avail;
    const Qcool = kCircuit * coolFrac * (this.T - (CFG.TjacketNom - 273.15));

    // CSTR 能量衡算：进料带入 + 反应放热 - 冷却移热 - 出料带出
    const fFlow = CFG.CpFlow * fFrac;
    const Qfeed = fFlow * ((CFG.Tf - 273.15) - this.T);
    const dT = (Qfeed + Qgen - Qcool) / (CFG.CpFlow * 12);
    this.T = clamp(this.T + dT * dt, 5, 400);

    // 夹套温度随反应温度缓慢跟随（用于流程图展示）
    this.Tj += ((this.T - 6.4) - this.Tj) * Math.min(1, 0.02 * dt);

    // 产品管线：反应器结果延迟后才在产品罐表现
    this.productQueue.push({ x: this.x, ratio: inlet.ratio });
    if (this.productQueue.length > CFG.productDelay) this.productQueue.shift();
    const prod = this.productQueue[0];
    this.purity = this.computePurity(prod.x, prod.ratio);

    // 压力：气相饱和压力随温度指数上升，叠加流动背压
    const pSat = 1.1 * Math.exp(0.045 * (this.T - 90));
    const pFlow = 0.15 * clamp(inlet.f / CFG.Fnom, 0, 1.2);
    const pTarget = pSat + pFlow;
    this.P += (pTarget - this.P) * Math.min(1, dt / 3);

    // 安全阀：超过起跳压力泄放，压力被钳住但不解除根因
    if (this.P >= CFG.P_trip) {
      if (!this.reliefOpen) {
        this.reliefOpen = true;
        this.log('WARN', '安全阀起跳泄放，压力正在释放');
      }
      this.P = CFG.P_trip - 0.02;
    } else if (this.reliefOpen && this.P < CFG.P_protect) {
      this.reliefOpen = false;
    }
  }

  advanceActuators(dt) {
    const move = (cur, target, rate) => {
      const step = Math.sign(target - cur) * Math.min(Math.abs(target - cur), rate * dt);
      return cur + step;
    };
    this.loadActual = move(this.loadActual, this.loadTarget, CFG.loadRate);
    this.coolActual = move(this.coolActual, this.coolingTarget, CFG.valveRate);

    if (this.switching) {
      const sw = this.switching;
      sw.elapsed += dt;
      if (sw.elapsed >= CFG.switchSeconds) {
        this.circuit = sw.to;
        this.switching = null;
        this.log('INFO', `冷却回路已切至${sw.to === 'main' ? '主回路' : '备用回路'}，冷却能力恢复`);
      }
    }
  }

  updateStableCounter() {
    const dT = this.series.length >= 2 ? Math.abs(this.T - this.series[this.series.length - 1].T) : 0;
    const dP = this.series.length >= 2 ? Math.abs(this.P - this.series[this.series.length - 1].P) : 0;
    const dX = this.series.length >= 2 ? Math.abs(this.x - this.series[this.series.length - 1].x) : 0;
    const calm =
      this.phase === 'NORMAL' || this.phase === 'WARNING'
        ? dT <= CFG.stableTolT && dP <= CFG.stableTolP && dX <= CFG.stableTolX
        : false;
    this.stableNormalSeconds = calm ? this.stableNormalSeconds + DT : 0;
  }

  isStable() {
    return this.phase === 'NORMAL' && this.stableNormalSeconds >= CFG.stableSeconds;
  }

  recoveryGuidance() {
    if (this.phase !== 'RECOVERY') return null;
    const r = this.recovery;
    if (r.stage === 1) {
      return {
        stage: 1,
        canAdvance: this.T < CFG.recoveryCooldownT,
        hint: `置换降温中，反应温度 ${this.T.toFixed(1)}°C，需降至 ${CFG.recoveryCooldownT}°C 以下`,
      };
    }
    if (r.stage === 2) {
      return {
        stage: 2,
        canAdvance: this.recoveryStage2Ready(),
        hint: `20% 低负荷引料观察，需连续 ${CFG.recoveryStableSeconds}s 满足 T<${CFG.recoveryStableT}°C、P<${CFG.P_warn}MPa、纯度≥${(CFG.recoveryStablePurity * 100).toFixed(0)}%（当前 ${r.stableSeconds}s）`,
      };
    }
    return {
      stage: 3,
      canAdvance: false,
      hint: `自动升负荷至 ${(CFG.recoveryRampTarget * 100).toFixed(0)}%，连续稳定 ${CFG.recoveryStableSeconds}s 后完成恢复（当前 ${r.stableSeconds}s，负荷 ${(this.loadActual * 100).toFixed(0)}%）`,
    };
  }

  snapshot() {
    return {
      t: this.now,
      phase: this.phase,
      phaseLabel: PHASE_LABEL[this.phase],
      valves: { A: this.valveA, B: this.valveB },
      load: { target: this.loadTarget, actual: this.loadActual },
      cooling: {
        target: this.coolingTarget,
        actual: this.coolActual,
        circuit: this.circuit,
        availability: this.coolingAvailability(),
        switching: this.switching
          ? { from: this.switching.from, to: this.switching.to, progress: this.switching.elapsed / CFG.switchSeconds }
          : null,
      },
      T: this.T,
      Tj: this.Tj,
      P: this.P,
      x: this.x,
      purity: this.purity,
      ratio: this.valveA / Math.max(this.valveB, 0.02),
      feedInPipe: this.feedQueue.map((q) => ({ ratio: q.ratio, f: q.f })),
      reliefOpen: this.reliefOpen,
      flags: { ...this.flags },
      stable: this.isStable(),
      stableSeconds: this.stableNormalSeconds,
      recovery: this.recoveryGuidance(),
      events: this.events.slice(-40),
    };
  }
  coolingAvailability() {
    if (this.phase === 'TRIP' || this.phase === 'ABORTED') return 1; // 急冷泵满能力
    if (!this.switching) return 1;
    // 切换期间能力下凹：两端约 65%，中段最低约 25%（倒空/引液阶段）
    const u = clamp(this.switching.elapsed / CFG.switchSeconds, 0, 1);
    return 0.25 + 0.4 * Math.abs(2 * u - 1);
  }

  computePurity(x, ratio) {
    // 额定点（x=0.70, T=90°C, 配比 1:1）纯度约 97%
    // 低转化导致未反应物夹带；高温诱发副反应；配比偏离使过量组分/副产物进入产品
    const conv = clamp(0.82 + 0.18 * ((x - 0.45) / 0.25), 0.55, 1);
    const selT = clamp(1 - Math.max(0, this.T - 98) * 0.010 - Math.max(0, 78 - this.T) * 0.003, 0.55, 1);
    const dev = Math.abs(Math.log(Math.max(ratio, 0.05))) / 0.22;
    const selR = clamp(1 - dev * 0.16, 0.55, 1);
    return clamp(0.97 * conv * selT * selR, 0, 1);
  }

  // ---------- 阶段状态机 ----------

  enterTrip(reason, aborted = false) {
    this.phase = aborted ? 'ABORTED' : 'TRIP';
    this.flags.hiT = false;
    this.flags.hiP = false;
    this.recovery = null;
    this.switching = null;
    this.valveA = 1;
    this.valveB = 1;
    this.coolingTarget = 1;
    this.coolActual = Math.max(this.coolActual, 0.6);
    this.loadTarget = 0;
    // 停车置换：进料管与产品管中的不合格物料按规程吹扫（以中性料流占位）
    this.feedQueue = Array.from({ length: CFG.feedDelay }, () => ({ ratio: 1, f: 0 }));
    this.productQueue = Array.from({ length: CFG.productDelay }, () => ({ x: 0.7, ratio: 1 }));
    this.x = 0;
    this.log('TRIP', `${reason}。联锁动作：切断 A/B 进料，急冷泵投用满负荷，装置进入紧急停车`);
  }

  judgePhase() {
    const f = this.flags;
    f.hiT = this.T >= CFG.T_warn;
    f.hiP = this.P >= CFG.P_warn;
    f.purityLow = this.purity < CFG.purityWarn;
    f.purityBad = this.purity < CFG.purityBad;

    // 硬保护线：温度失控或压力超压 -> 紧急停车（恢复阶段同样适用）
    if (this.T >= CFG.T_trip) {
      if (this.phase !== 'TRIP' && this.phase !== 'ABORTED') {
        this.enterTrip(`反应温度 ${this.T.toFixed(1)}°C 达到停车线 ${CFG.T_trip}°C，判定温度失控`);
      }
      return;
    }
    if (this.P >= CFG.P_trip) {
      if (this.phase !== 'TRIP' && this.phase !== 'ABORTED') {
        this.enterTrip(`压力 ${this.P.toFixed(2)} MPa 达到停车线 ${CFG.P_trip} MPa，压力累积失控`);
      }
      return;
    }

    if (this.phase === 'RECOVERY') {
      this.updateRecovery();
      return;
    }
    if (this.phase === 'TRIP' || this.phase === 'ABORTED') return;

    const protect = this.T >= CFG.T_protect || this.P >= CFG.P_protect;
    const warn = f.hiT || f.hiP || f.purityLow;

    if (protect && this.phase !== 'PROTECTION') {
      this.phase = 'PROTECTION';
      this.coolingTarget = 1;
      this.loadTarget = Math.min(this.loadTarget, CFG.protectLoadCap);
      this.log(
        'PROTECT',
        `参数达到保护线（温度 ${CFG.T_protect}°C / 压力 ${CFG.P_protect} MPa），保护系统介入：冷却阀强制全开，负荷被限制至 ${(CFG.protectLoadCap * 100).toFixed(0)}%`
      );
    } else if (!protect && this.phase === 'PROTECTION') {
      if (warn) {
        this.phase = 'WARNING';
        this.log('INFO', '危险参数退出保护线，仍处于预警区间，保护动作部分保持');
      } else {
        this.phase = 'NORMAL';
        this.log('INFO', '工艺参数全部回归正常区间，保护动作解除');
      }
    } else if (!protect && this.phase === 'WARNING' && !warn) {
      this.phase = 'NORMAL';
      this.log('INFO', '预警消除，装置恢复正常运行');
    } else if (!protect && this.phase === 'NORMAL' && warn) {
      this.phase = 'WARNING';
      const items = [];
      if (f.hiT) items.push(`温度 ${this.T.toFixed(1)}°C 超预警线`);
      if (f.hiP) items.push(`压力 ${this.P.toFixed(2)} MPa 超预警线`);
      if (f.purityLow) items.push(`产品纯度 ${(this.purity * 100).toFixed(1)}% 低于预警值`);
      this.log('WARN', `预警：${items.join('；')}`);
    }

    // 保护阶段持续强制约束
    if (this.phase === 'PROTECTION') {
      this.coolingTarget = 1;
      this.loadTarget = Math.min(this.loadTarget, CFG.protectLoadCap);
    }
  }

  updateRecovery() {
    const r = this.recovery;
    if (r.stage === 1) {
      this.coolingTarget = 1;
      this.loadTarget = 0;
    } else if (r.stage === 2) {
      this.coolingTarget = 1;
      this.loadTarget = 0.2;
      if (this.T < CFG.recoveryStableT && this.P < CFG.P_warn && this.purity >= CFG.recoveryStablePurity) {
        r.stableSeconds += DT;
      } else {
        r.stableSeconds = 0;
      }
    } else if (r.stage === 3) {
      this.coolingTarget = 1;
      this.loadTarget = Math.min(this.loadTarget + CFG.recoveryRampRate * DT, CFG.recoveryRampTarget);
      const stable =
        this.T < CFG.recoveryStableT &&
        this.P < CFG.P_warn &&
        this.purity >= CFG.recoveryStablePurity &&
        this.loadTarget >= CFG.recoveryRampTarget - 0.001;
      if (stable) r.stableSeconds += DT;
      else r.stableSeconds = 0;
      if (r.stableSeconds >= CFG.recoveryStableSeconds) {
        this.phase = 'NORMAL';
        this.recovery = null;
        this.coolingTarget = 1;
        this.log('OK', '恢复生产程序完成：装置在 60% 额定负荷下稳定运行，恢复生产成功');
      }
    }
  }
}
const seedFrom = (sim) => ({
  phase: sim.phase,
  flags: structuredClone(sim.flags),
  recovery: structuredClone(sim.recovery),
  valveA: sim.valveA,
  valveB: sim.valveB,
  loadTarget: sim.loadTarget,
  loadActual: sim.loadActual,
  coolingTarget: sim.coolingTarget,
  coolActual: sim.coolActual,
  circuit: sim.circuit,
  switching: structuredClone(sim.switching),
  T: sim.T,
  Tj: sim.Tj,
  P: sim.P,
  x: sim.x,
  purity: sim.purity,
  feedQueue: structuredClone(sim.feedQueue),
  productQueue: structuredClone(sim.productQueue),
  now: sim.now,
});

module.exports = { Simulator, CFG, PHASES, PHASE_LABEL, seedFrom };
