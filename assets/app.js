/* PhyLab: Single-file JS powering tabs, games, and simulations.
   Structure:
   - Core UI: tabs, subtabs, lazy activation per-canvas
   - Utils: Vec2, RNG, UI helpers, timing
   - Games: SpaceGlider, TorqueTycoon, MirrorMadness
   - Simulations: Projectile, Pendulum, RC Circuit, Wave Interference
*/

(() => {
  "use strict";

  // ============== Utils ==============
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  class RNG {
    constructor(seed = 1234567) {
      this._s = seed >>> 0;
    }
    next() {
      // xorshift32
      let x = this._s;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this._s = x >>> 0;
      return this._s / 0xffffffff;
    }
    range(a, b) { return a + (b - a) * this.next(); }
    pick(arr) { return arr[(this.next() * arr.length) | 0]; }
  }

  class Vec2 {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    clone() { return new Vec2(this.x, this.y); }
    set(x, y){ this.x=x; this.y=y; return this; }
    add(v){ this.x+=v.x; this.y+=v.y; return this; }
    sub(v){ this.x-=v.x; this.y-=v.y; return this; }
    scale(s){ this.x*=s; this.y*=s; return this; }
    len(){ return Math.hypot(this.x, this.y); }
    norm(){ const L=this.len()||1; this.x/=L; this.y/=L; return this; }
    dot(v){ return this.x*v.x + this.y*v.y; }
    perp(){ return new Vec2(-this.y, this.x); }
    static add(a,b){ return new Vec2(a.x+b.x, a.y+b.y); }
    static sub(a,b){ return new Vec2(a.x-b.x, a.y-b.y); }
    static scale(a,s){ return new Vec2(a.x*s, a.y*s); }
  }

  function createEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function sliderRow({ label, min, max, step=1, value, unit="", onInput }) {
    const row = createEl("div","row");
    const lab = createEl("label", null, label);
    const range = createEl("input");
    range.type="range"; range.min=min; range.max=max; range.step=step; range.value=value;
    const num = createEl("input");
    num.type="number"; num.min=min; num.max=max; num.step=step; num.value=value;
    const u = createEl("span","muted small", unit);
    const sync = v => { range.value=v; num.value=v; onInput(+v); };
    range.addEventListener("input", e => sync(e.target.value));
    num.addEventListener("input", e => sync(e.target.value));
    row.append(lab, range, num, u);
    return row;
  }

  function buttonRow({ label, onClick, variant }) {
    const row = createEl("div","row");
    const btn = createEl("a", `btn ${variant||""}`, label);
    btn.href="#";
    btn.addEventListener("click", e => { e.preventDefault(); onClick?.(); });
    row.append(btn);
    return row;
  }

  function badge(text, type="success"){
    const b = createEl("span", `badge ${type}`, text);
    return b;
  }

  function drawRoundedRect(ctx, x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y, x+w, y+h, r);
    ctx.arcTo(x+w, y+h, x, y+h, r);
    ctx.arcTo(x, y+h, x, y, r);
    ctx.arcTo(x, y, x+w, y, r);
    ctx.closePath();
  }

  // Global clock
  let lastTs = performance.now();
  let dtCap = 1/30;

  // ============== Core UI (tabs/subtabs) ==============
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function initTabs(){
    const tabButtons = $$(".tab");
    const panels = $$(".panel");
    function activateTab(name){
      tabButtons.forEach(b=>{
        const active = b.dataset.tab === name;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true":"false");
      });
      panels.forEach(p => p.classList.toggle("active", p.id === name));
      onPanelActivated(name);
    }
    tabButtons.forEach(btn=>{
      btn.addEventListener("click", ()=> activateTab(btn.dataset.tab));
    });
    // allow CTA "data-tab-jump"
    $$('[data-tab-jump]').forEach(a=>{
      a.addEventListener("click", (e)=>{ e.preventDefault(); activateTab(a.dataset.tabJump); });
    });

    // Subtabs logic per area
    function initSubtabs(scopeSelector){
      const scope = $(scopeSelector);
      if(!scope) return;
      const subtabs = scope.querySelectorAll(".subtab");
      const subpanels = scope.querySelectorAll(".subpanel");
      function activateSub(name){
        subtabs.forEach(b=> b.classList.toggle("active", b.dataset.subtab===name));
        subpanels.forEach(p=> p.classList.toggle("active", p.dataset.subpanel===name));
        onSubpanelActivated(scopeSelector, name);
      }
      subtabs.forEach(btn => btn.addEventListener("click", ()=> activateSub(btn.dataset.subtab)));
    }
    initSubtabs("#games");
    initSubtabs("#simulations");
  }

  // Set year
  $("#year").textContent = new Date().getFullYear();

  // ============== Canvas activation switching ==============
  const canvasHandlers = {
    // home
    "home-orbit": null,
    // games
    "game-glider": null,
    "game-torque": null,
    "game-optics": null,
    // sims
    "sim-projectile": null,
    "sim-pendulum": null,
    "sim-rc": null,
    "sim-waves": null,
  };

  function onPanelActivated(name){
    // Start/stop renderers depending on the active panel
    const activePanels = {
      home: ["home-orbit"],
      games: activeGameCanvasNames(),
      simulations: activeSimCanvasNames(),
      videos: [],
      learn: [],
      about: [],
    };
    const active = new Set(activePanels[name] || []);
    for (const id of Object.keys(canvasHandlers)) {
      const handler = canvasHandlers[id];
      if(!handler) continue;
      const shouldRun = active.has(id);
      handler.setRunning(shouldRun);
    }
  }

  function onSubpanelActivated(sectionSelector, subName){
    if(sectionSelector === "#games"){
      // toggle canvas running per subgame
      const active = {
        "glider": ["game-glider"],
        "torque": ["game-torque"],
        "optics": ["game-optics"],
      }[subName] || [];
      for (const id of ["game-glider","game-torque","game-optics"]) {
        canvasHandlers[id]?.setRunning(active.includes(id));
      }
    }
    if(sectionSelector === "#simulations"){
      const active = {
        "projectile": ["sim-projectile"],
        "pendulum": ["sim-pendulum"],
        "rc": ["sim-rc"],
        "waves": ["sim-waves"],
      }[subName] || [];
      for (const id of ["sim-projectile","sim-pendulum","sim-rc","sim-waves"]) {
        canvasHandlers[id]?.setRunning(active.includes(id));
      }
    }
  }

  function activeGameCanvasNames(){
    const btn = $("#games .subtab.active");
    if(!btn) return [];
    return onSubpanelActivatedDummy("games", btn.dataset.subtab);
  }
  function activeSimCanvasNames(){
    const btn = $("#simulations .subtab.active");
    if(!btn) return [];
    return onSubpanelActivatedDummy("simulations", btn.dataset.subtab);
  }
  function onSubpanelActivatedDummy(section, name){
    if(section==="games"){
      return { glider:["game-glider"], torque:["game-torque"], optics:["game-optics"] }[name] || [];
    }
    if(section==="simulations"){
      return { projectile:["sim-projectile"], pendulum:["sim-pendulum"], rc:["sim-rc"], waves:["sim-waves"] }[name] || [];
    }
    return [];
  }

  // ============== Renderer wrapper ==============
  class CanvasRunner {
    constructor(canvas, draw, onResize){
      this.c = canvas;
      this.ctx = canvas.getContext("2d");
      this.draw = draw;
      this.onResize = onResize || (()=>{});
      this.running = false;
      this._raf = 0;
      window.addEventListener("resize", ()=> this.resize());
      this.resize();
    }
    resize(){
      const rect = this.c.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      this.c.width = Math.floor(rect.width * dpr);
      this.c.height = Math.floor(rect.height * dpr);
      this.ctx.setTransform(dpr,0,0,dpr,0,0);
      this.onResize(this.c, this.ctx);
    }
    setRunning(run){
      if(run && !this.running){
        this.running = true;
        this._tick(performance.now());
      } else if(!run && this.running){
        this.running = false;
        cancelAnimationFrame(this._raf);
      }
    }
    _tick(ts){
      if(!this.running) return;
      const dt = Math.min(0.05, (ts - lastTs)/1000);
      lastTs = ts;
      this.draw(this.c, this.ctx, dt);
      this._raf = requestAnimationFrame(t=>this._tick(t));
    }
  }

  // ============== Home Orbit ==============
  function initHomeOrbit(){
    const canvas = $("#home-orbit");
    if(!canvas) return;
    const rng = new RNG(42);
    const orbs = [];
    const N = 120;
    for(let i=0;i<N;i++){
      orbs.push({
        r: rng.range(40, 280),
        a: rng.range(0, TAU),
        w: rng.range(-0.6, 0.8),
        s: rng.range(1, 3),
        hue: rng.range(180, 280)
      });
    }
    const center = new Vec2();

    canvasHandlers["home-orbit"] = new CanvasRunner(canvas, (c, ctx, dt)=>{
      ctx.clearRect(0,0,c.width, c.height);
      center.set(c.width/2, c.height/2);
      // glow star
      const g = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, 180);
      g.addColorStop(0, "rgba(124,77,255,.45)");
      g.addColorStop(1, "rgba(124,77,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(center.x, center.y, 180, 0, TAU); ctx.fill();

      // orbs
      for(const o of orbs){
        o.a += o.w * dt * 0.5;
        const x = center.x + Math.cos(o.a)*o.r;
        const y = center.y + Math.sin(o.a)*o.r * 0.7;
        ctx.fillStyle = `hsla(${o.hue},80%,70%,.8)`;
        ctx.beginPath(); ctx.arc(x,y, o.s, 0, TAU); ctx.fill();
      }
      // title watermark
      ctx.fillStyle = "rgba(255,255,255,.05)";
      ctx.font = "900 72px Inter, sans-serif";
      ctx.fillText("Physics is Play", 24, c.height - 28);
    });
    canvasHandlers["home-orbit"].setRunning(true);
  }

  // ============== Games ============== 

  // Space Glider
  function initGameGlider(){
    const canvas = $("#game-glider");
    if(!canvas) return;
    const ui = $("#glider-ui");
    const rng = new RNG(99);

    const keys = {};
    window.addEventListener("keydown", (e)=>{ keys[e.key.toLowerCase()] = true; });
    window.addEventListener("keyup", (e)=>{ keys[e.key.toLowerCase()] = false; });

    let level = 1;
    let score = 0;
    let fuel = 100;
    let ship, wells, orbs, bounds;

    function resetLevel(lv=1){
      level = lv;
      score = 0;
      fuel = 100;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      bounds = { x:0, y:0, w, h };
      ship = {
        p: new Vec2(w*0.15, h*0.5),
        v: new Vec2(0,0),
        a: new Vec2(0,0),
        angle: 0,
        r: 12
      };
      wells = [];
      const W = (lv===1) ? 3 : 5;
      for(let i=0;i<W;i++){
        wells.push({
          p: new Vec2(rng.range(w*0.35, w*0.9), rng.range(h*0.15, h*0.85)),
          m: rng.range(20000, 40000),
          R: rng.range(24, 42)
        });
      }
      orbs = [];
      const O = (lv===1) ? 7 : 12;
      for(let i=0;i<O;i++){
        orbs.push({
          p: new Vec2(rng.range(w*0.25, w*0.95), rng.range(h*0.1, h*0.9)),
          r: 8,
          got:false
        });
      }
    }

    // UI
    ui.innerHTML = "";
    const info = createEl("div","row");
    const scoreBadge = badge("Score: 0", "success");
    const fuelBadge = badge("Fuel: 100%", "warn");
    info.append(scoreBadge, fuelBadge);
    ui.append(info);
    ui.append(buttonRow({
      label: "Restart (R)",
      onClick: ()=> resetLevel(level)
    }));
    ui.append(buttonRow({
      label: "Next Level",
      variant: "primary",
      onClick: ()=> resetLevel(level===1?2:1)
    }));

    function update(dt, c){
      // integrate gravity
      const G = 1000;
      ship.a.set(0,0);
      for(const w of wells){
        const d = Vec2.sub(w.p, ship.p);
        const r2 = Math.max(120, d.x*d.x+d.y*d.y); // avoid singularity
        const F = G * w.m / r2;
        ship.a.add(Vec2.scale(d, F/Math.sqrt(r2)));
      }

      // controls
      let thrust = 0;
      if(keys["arrowup"] || keys["w"]) thrust = 120;
      if(keys["shift"]) thrust *= 1.7;
      if(thrust>0 && fuel>0){
        const dir = new Vec2(Math.cos(ship.angle), Math.sin(ship.angle));
        ship.a.add(Vec2.scale(dir, thrust));
        fuel = clamp(fuel - dt* (keys["shift"]?4:2), 0, 100);
      }
      if(keys["arrowleft"] || keys["a"]) ship.angle -= 2.6 * dt;
      if(keys["arrowright"] || keys["d"]) ship.angle += 2.6 * dt;
      if(keys["r"]) resetLevel(level);

      // integrate motion
      ship.v.add(Vec2.scale(ship.a, dt));
      ship.p.add(Vec2.scale(ship.v, dt));

      // bounds bounce
      if(ship.p.x<0||ship.p.x>c.width){ ship.v.x*=-0.6; ship.p.x=clamp(ship.p.x, 0, c.width); }
      if(ship.p.y<0||ship.p.y>c.height){ ship.v.y*=-0.6; ship.p.y=clamp(ship.p.y, 0, c.height); }

      // check orb collection
      for(const o of orbs){
        if(o.got) continue;
        const dx = o.p.x - ship.p.x;
        const dy = o.p.y - ship.p.y;
        if(dx*dx+dy*dy < (o.r+ship.r)*(o.r+ship.r)){
          o.got = true;
          score += 10;
        }
      }

      // check collisions with wells (lose)
      for(const w of wells){
        const dx = w.p.x - ship.p.x, dy = w.p.y - ship.p.y;
        if(dx*dx+dy*dy < (w.R+ship.r)*(w.R+ship.r)){
          resetLevel(level);
          break;
        }
      }

      // UI update
      scoreBadge.textContent = `Score: ${score}`;
      fuelBadge.textContent = `Fuel: ${fuel.toFixed(0)}%`;

      // win if all orbs collected
      if(orbs.every(o=>o.got)){
        scoreBadge.textContent = `Score: ${score} ✓`;
      }
    }

    function draw(c, ctx){
      // background grid
      ctx.clearRect(0,0,c.width,c.height);
      ctx.fillStyle = "#0b1018";
      ctx.fillRect(0,0,c.width, c.height);
      ctx.strokeStyle = "rgba(255,255,255,.05)";
      ctx.lineWidth = 1;
      for(let x=0; x<c.width; x+=40){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,c.height); ctx.stroke(); }
      for(let y=0; y<c.height; y+=40){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(c.width,y); ctx.stroke(); }

      // wells
      for(const w of wells){
        const g = ctx.createRadialGradient(w.p.x, w.p.y, 0, w.p.x, w.p.y, w.R*4);
        g.addColorStop(0, "rgba(124,77,255,.35)");
        g.addColorStop(1, "rgba(124,77,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(w.p.x, w.p.y, w.R*3.2, 0, TAU); ctx.fill();

        ctx.strokeStyle = "rgba(180,150,255,.8)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(w.p.x, w.p.y, w.R, 0, TAU); ctx.stroke();
      }

      // orbs
      for(const o of orbs){
        if(o.got) continue;
        ctx.fillStyle = "rgba(110,231,255,.9)";
        ctx.beginPath(); ctx.arc(o.p.x, o.p.y, o.r, 0, TAU); ctx.fill();
      }

      // ship
      ctx.save();
      ctx.translate(ship.p.x, ship.p.y);
      ctx.rotate(ship.angle);
      // flame
      if((keys["arrowup"]||keys["w"]) && fuel>0){
        ctx.fillStyle = "rgba(255,180,80,.7)";
        ctx.beginPath(); ctx.moveTo(-12, -6); ctx.lineTo(-12, 6); ctx.lineTo(-22 - Math.random()*12, 0); ctx.closePath(); ctx.fill();
      }
      // body
      drawRoundedRect(ctx, -12, -8, 24, 16, 6);
      const g2 = ctx.createLinearGradient(-12,0,12,0);
      g2.addColorStop(0,"#1e2740"); g2.addColorStop(1,"#6ee7ff");
      ctx.fillStyle = g2;
      ctx.fill();
      ctx.restore();
    }

    function loop(c, ctx, dt){
      update(dt, c);
      draw(c, ctx);
    }

    function onResize(){
      resetLevel(level);
    }

    canvasHandlers["game-glider"] = new CanvasRunner(canvas, loop, onResize);
    resetLevel(1);
  }

  // Torque Tycoon
  function initGameTorque(){
    const canvas = $("#game-torque");
    if(!canvas) return;
    const ui = $("#torque-ui");
    const rng = new RNG(123);
    const masses = [];
    const lever = { cx: 0, cy: 0, length: 600, angle: 0, target: 0 };
    let dragging = null;

    function reset(){
      const w = canvas.clientWidth, h = canvas.clientHeight;
      lever.cx = w/2; lever.cy = h*0.6; lever.angle = 0;
      lever.length = Math.min(700, w*0.8);
      lever.target = rng.range(-15, 15) * Math.PI/180;
      masses.length = 0;
      // fixed mass on left to create challenge
      masses.push({ x: -lever.length/3, m: 10, fixed:true });
    }

    function sumTorque(){
      // about pivot, torque = r x F ; F = m g downward
      const g = 9.81;
      let tau = 0;
      for(const ms of masses){
        const r = ms.x; // horizontal from pivot
        const F = ms.m * g;
        // torque = r * F * sin(90°) = r*F, sign by side
        tau += r * F;
      }
      return tau;
    }

    function targetReached(){
      // simple proportional: angle ~ tau / stiffness
      const stiffness = 18000;
      const angle = sumTorque()/stiffness;
      return Math.abs(angle - lever.target) < 0.02;
    }

    // UI
    ui.innerHTML = "";
    const info = createEl("div","row");
    const targetBadge = badge("Target: 0°", "warn");
    const tip = createEl("div","muted small","Drag masses on the lever. Add more masses and try to match the target angle.");
    info.append(targetBadge);
    ui.append(info, tip);
    ui.append(sliderRow({
      label: "Add mass (kg)",
      min:1, max:30, step:1, value:8, unit:"kg",
      onInput:(v)=> addBtn.textContent = `Add ${v} kg mass`
    }));
    let pendingMass = 8;
    const lastRow = ui.lastElementChild;
    const range = lastRow.querySelector('input[type="range"]');
    const num = lastRow.querySelector('input[type="number"]');
    range.addEventListener("input", e=> pendingMass=+e.target.value);
    num.addEventListener("input", e=> pendingMass=+e.target.value);

    const addBtn = createEl("a","btn primary","Add 8 kg mass");
    addBtn.href="#";
    addBtn.addEventListener("click", e=>{ e.preventDefault();
      masses.push({ x: 0, m: pendingMass, fixed:false });
    });
    const btnRow = createEl("div","row"); btnRow.append(addBtn);
    ui.append(btnRow);
    ui.append(buttonRow({ label:"Reset", onClick: reset }));

    // interaction
    canvas.addEventListener("mousedown", e=>{
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      // project to lever x-axis
      for(const ms of masses){
        const x = lever.cx + ms.x;
        const y = lever.cy;
        if(Math.hypot(mx-x, my-y) < 16 && !ms.fixed){
          dragging = ms; break;
        }
      }
    });
    window.addEventListener("mouseup", ()=> dragging=null);
    window.addEventListener("mousemove", e=>{
      if(!dragging) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      dragging.x = clamp(mx - lever.cx, -lever.length/2, lever.length/2);
    });

    function updateUI(){
      targetBadge.textContent = `Target: ${(lever.target*180/Math.PI).toFixed(1)}°`;
      if(targetReached()){ 
        targetBadge.className = "badge success";
        targetBadge.textContent += " ✓";
      } else {
        targetBadge.className = "badge warn";
      }
    }

    function draw(c, ctx){
      ctx.clearRect(0,0,c.width,c.height);
      // ground
      ctx.fillStyle = "#0b121e";
      ctx.fillRect(0,0,c.width,c.height);

      // pivot
      ctx.fillStyle = "rgba(124,77,255,.6)";
      ctx.beginPath(); ctx.arc(lever.cx, lever.cy, 10, 0, TAU); ctx.fill();

      // lever
      ctx.save();
      ctx.translate(lever.cx, lever.cy);
      ctx.rotate(lever.angle);
      ctx.strokeStyle = "rgba(255,255,255,.2)";
      ctx.lineWidth = 18;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-lever.length/2, 0);
      ctx.lineTo(lever.length/2, 0);
      ctx.stroke();

      // tick marks
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,.12)";
      for(let i=-5;i<=5;i++){
        ctx.beginPath(); ctx.moveTo(i*lever.length/10, -12); ctx.lineTo(i*lever.length/10, 12); ctx.stroke();
      }

      // masses
      for(const ms of masses){
        const x = ms.x;
        drawRoundedRect(ctx, x-14, -14, 28, 28, 6);
        ctx.fillStyle = ms.fixed ? "rgba(255,130,130,.9)" : "rgba(110,231,255,.9)";
        ctx.fill();
        ctx.fillStyle = "#0a0f16";
        ctx.font = "bold 12px Inter";
        ctx.textAlign = "center";
        ctx.fillText(`${ms.m}kg`, x, 4);
      }

      ctx.restore();

      // target marker
      ctx.save();
      ctx.translate(lever.cx, lever.cy);
      ctx.rotate(lever.target);
      ctx.strokeStyle = "rgba(34,211,238,.7)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(lever.length/2 + 20, 0); ctx.stroke();
      ctx.restore();
    }

    function step(dt){
      // simple spring-like relation angle ~ tau/stiffness
      const stiffness = 18000;
      const targetAngle = sumTorque()/stiffness;
      // relax towards
      lever.angle = lerp(lever.angle, targetAngle, 1 - Math.exp(-dt*6));
      updateUI();
    }

    canvasHandlers["game-torque"] = new CanvasRunner(canvas, (c,ctx,dt)=>{ step(dt); draw(c,ctx); }, ()=> reset());
    reset();
  }

  // Mirror Madness
  function initGameOptics(){
    const canvas = $("#game-optics");
    if(!canvas) return;
    const ui = $("#optics-ui");

    const mirrors = [
      { p:new Vec2(280, 300), dir: 0, len: 160 },
      { p:new Vec2(640, 220), dir: Math.PI/4, len: 160 },
    ];
    const targets = [
      { p:new Vec2(820, 360), r: 14, hit:false }
    ];
    const source = { p: new Vec2(140, 120), dir: 0.1 };

    ui.innerHTML = "";
    ui.append(createEl("div","muted small","Rotate mirrors to guide the beam into the target. Law of reflection: angle in = angle out."));
    mirrors.forEach((m, i)=>{
      const row = sliderRow({
        label: `Mirror ${i+1} angle`,
        min: -90, max: 90, step:1, value: Math.round(m.dir*180/Math.PI),
        unit: "deg",
        onInput: (v)=> m.dir = v*Math.PI/180
      });
      ui.append(row);
    });
    ui.append(buttonRow({ label:"Reset", onClick: ()=>{
      mirrors[0].dir = 0; mirrors[1].dir = Math.PI/4; targets.forEach(t=>t.hit=false);
    }}));

    function castRay(start, dir, depth=0){
      if(depth>4) return [{p:start, n:null}];
      const hits = [];
      const ray = { p: start.clone(), d: new Vec2(Math.cos(dir), Math.sin(dir)) };
      let best = null;
      // check mirror intersections
      for(const m of mirrors){
        // mirror segment endpoints
        const t = new Vec2(Math.cos(m.dir), Math.sin(m.dir));
        const a = Vec2.add(m.p, Vec2.scale(t, -m.len/2));
        const b = Vec2.add(m.p, Vec2.scale(t, m.len/2));
        const h = segmentRayIntersection(a, b, ray.p, ray.d);
        if(h && (!best || h.t < best.t)) best = {...h, mirror:m};
      }
      if(best){
        const hitPoint = Vec2.add(ray.p, Vec2.scale(ray.d, best.t));
        const tangent = new Vec2(Math.cos(best.mirror.dir), Math.sin(best.mirror.dir));
        const normal = tangent.perp().norm(); // one of the normals
        // reflect
        const d = ray.d;
        const reflect = Vec2.sub(d, Vec2.scale(normal, 2 * d.dot(normal)));
        // accumulate and continue
        hits.push({ p:start, n:null });
        hits.push({ p:hitPoint, n:normal });
        const rest = castRay(hitPoint, Math.atan2(reflect.y, reflect.x), depth+1);
        return hits.concat(rest);
      } else {
        // no hit, extend ray to canvas bounds
        hits.push({ p:start, n:null });
        hits.push({ p: Vec2.add(start, Vec2.scale(ray.d, 2000)), n:null });
        return hits;
      }
    }

    function segmentRayIntersection(a, b, p, d){
      // Solve p + t d = a + u (b-a), with t>=0, 0<=u<=1
      const r = Vec2.sub(b,a);
      const cross = (v,w)=> v.x*w.y - v.y*w.x;
      const denom = cross(d, r);
      if(Math.abs(denom) < 1e-6) return null;
      const t = cross(Vec2.sub(a,p), r) / denom;
      const u = cross(Vec2.sub(a,p), d) / denom;
      if(t>=0 && u>=0 && u<=1) return { t, u };
      return null;
    }

    function draw(c, ctx){
      ctx.clearRect(0,0,c.width,c.height);
      ctx.fillStyle="#0b121e"; ctx.fillRect(0,0,c.width,c.height);

      // mirrors
      ctx.lineWidth=6; ctx.lineCap="round";
      ctx.strokeStyle="rgba(124,77,255,.9)";
      for(const m of mirrors){
        const t = new Vec2(Math.cos(m.dir), Math.sin(m.dir));
        const a = Vec2.add(m.p, Vec2.scale(t, -m.len/2));
        const b = Vec2.add(m.p, Vec2.scale(t, m.len/2));
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      }

      // targets
      for(const tg of targets){
        ctx.strokeStyle = tg.hit ? "rgba(34,197,94,.9)" : "rgba(255,255,255,.3)";
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(tg.p.x, tg.p.y, tg.r, 0, TAU); ctx.stroke();
      }

      // cast beam
      const pts = castRay(source.p, source.dir);
      ctx.strokeStyle = "rgba(110,231,255,.9)";
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.moveTo(pts[0].p.x, pts[0].p.y);
      for(let i=1;i<pts.length;i++){
        ctx.lineTo(pts[i].p.x, pts[i].p.y);
      }
      ctx.stroke();

      // check target
      for(const tg of targets){
        tg.hit = false;
        // if final segment passes inside target circle
        for(let i=0;i<pts.length-1;i++){
          const a=pts[i].p, b=pts[i+1].p;
          if(distToSegment(tg.p, a, b) < tg.r){ tg.hit=true; break; }
        }
      }

      // source marker
      ctx.fillStyle = "rgba(34,211,238,.8)";
      ctx.beginPath(); ctx.arc(source.p.x, source.p.y, 8, 0, TAU); ctx.fill();
    }

    function distToSegment(p, a, b){
      const ab = Vec2.sub(b,a);
      const t = clamp(((p.x-a.x)*ab.x + (p.y-a.y)*ab.y)/(ab.x*ab.x+ab.y*ab.y), 0, 1);
      const proj = new Vec2(a.x + ab.x*t, a.y + ab.y*t);
      return Math.hypot(p.x-proj.x, p.y-proj.y);
    }

    canvasHandlers["game-optics"] = new CanvasRunner(canvas, (c,ctx)=> draw(c,ctx), ()=>{});
  }

  // ============== Simulations ============== 

  // Projectile Motion
  function initSimProjectile(){
    const canvas = $("#sim-projectile"); if(!canvas) return;
    const ui = $("#projectile-ui");
    const state = { v0: 40, angle: 45, g: 9.81, drag: 0.0, running:false, t:0, points:[] };

    ui.innerHTML = "";
    ui.append(sliderRow({ label:"Speed", min:5, max:100, step:1, value:state.v0, unit:"m/s", onInput:v=>{ state.v0=v; if(!state.running) generate(); } }));
    ui.append(sliderRow({ label:"Angle", min:5, max:85, step:1, value:state.angle, unit:"deg", onInput:v=>{ state.angle=v; if(!state.running) generate(); } }));
    ui.append(sliderRow({ label:"Gravity", min:1, max:20, step:.1, value:state.g, unit:"m/s²", onInput:v=>{ state.g=v; if(!state.running) generate(); } }));
    ui.append(sliderRow({ label:"Drag", min:0, max:.2, step:.005, value:state.drag, unit:"k", onInput:v=>{ state.drag=v; if(!state.running) generate(); } }));
    const row = createEl("div","row");
    const fire = createEl("a","btn primary","Fire");
    const stop = createEl("a","btn","Reset");
    fire.href = "#";
    stop.href = "#";
    fire.addEventListener("click", e=>{ e.preventDefault(); state.running = true; state.t=0; state.points = []; });
    stop.addEventListener("click", e=>{ e.preventDefault(); state.running=false; generate(); });
    row.append(fire, stop);
    ui.append(row);

    function generate(){
      // precompute trajectory without time animation
      state.points = [];
      const ang = state.angle*Math.PI/180;
      let vx = state.v0*Math.cos(ang), vy = -state.v0*Math.sin(ang);
      let x=0, y=0, dt=0.02;
      for(let i=0;i<400;i++){
        state.points.push({x,y});
        if(y>0 && i>0 && state.points[i-1].y<0) break;
        const v = Math.hypot(vx,vy);
        const ax = -state.drag*v*vx;
        const ay = state.g - state.drag*v*vy;
        vx += ax*dt; vy += ay*dt;
        x += vx*dt; y += vy*dt;
      }
    }
    generate();

    function draw(c, ctx, dt){
      ctx.clearRect(0,0,c.width,c.height);
      // axes
      ctx.fillStyle="#0b121e"; ctx.fillRect(0,0,c.width,c.height);
      ctx.strokeStyle="rgba(255,255,255,.15)";
      ctx.beginPath(); ctx.moveTo(40,c.height-40); ctx.lineTo(c.width-20, c.height-40); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(40,c.height-40); ctx.lineTo(40, 20); ctx.stroke();

      ctx.save();
      ctx.translate(40, c.height-40);
      const scale = 8;
      // path
      ctx.strokeStyle="rgba(110,231,255,.9)";
      ctx.lineWidth=2;
      ctx.beginPath();
      state.points.forEach((p,i)=> {
        const px = p.x*scale, py = p.y*scale;
        if(i===0) ctx.moveTo(px,-py); else ctx.lineTo(px,-py);
      });
      ctx.stroke();

      // animated projectile if running
      if(state.running){
        const dtSim = 0.016;
        const ang = state.angle*Math.PI/180;
        if(state.t===0) state.sim = { x:0, y:0, vx: state.v0*Math.cos(ang), vy:-state.v0*Math.sin(ang) };
        for(let iter=0; iter<Math.floor(dt/0.016); iter++){
          const v = Math.hypot(state.sim.vx, state.sim.vy);
          const ax = -state.drag*v*state.sim.vx;
          const ay = state.g - state.drag*v*state.sim.vy;
          state.sim.vx += ax*dtSim; state.sim.vy += ay*dtSim;
          state.sim.x += state.sim.vx*dtSim; state.sim.y += state.sim.vy*dtSim;
          if(state.sim.y>0 && state.sim.vy>0){ state.running=false; break; }
        }
        ctx.fillStyle="#fff";
        ctx.beginPath(); ctx.arc(state.sim.x*scale, -state.sim.y*scale, 5, 0, TAU); ctx.fill();
        state.t += dt;
      }
      ctx.restore();

      // range label
      const R = (state.v0*state.v0*Math.sin(2*state.angle*Math.PI/180)/state.g).toFixed(1);
      ctx.fillStyle="rgba(255,255,255,.8)";
      ctx.font="600 14px Inter";
      ctx.fillText(`Ideal range (no drag): ${R} m`, 50, 30);
    }

    canvasHandlers["sim-projectile"] = new CanvasRunner(canvas, (c,ctx,dt)=> draw(c,ctx,dt), ()=>{});
  }

  // Pendulum
  function initSimPendulum(){
    const canvas = $("#sim-pendulum"); if(!canvas) return;
    const ui = $("#pendulum-ui");
    const state = { L: 1.2, m:1, g:9.81, damping: 0.02, theta: Math.PI/4, omega:0, running:true };

    ui.innerHTML = "";
    ui.append(sliderRow({ label:"Length", min:0.5, max:3, step:0.05, value:state.L, unit:"m", onInput:v=> state.L=v }));
    ui.append(sliderRow({ label:"Damping", min:0, max:.1, step:.002, value:state.damping, unit:"", onInput:v=> state.damping=v }));
    ui.append(sliderRow({ label:"Gravity", min:1, max:20, step:.1, value:state.g, unit:"m/s²", onInput:v=> state.g=v }));
    const row = createEl("div","row");
    const kick = createEl("a","btn primary","Kick"); kick.href="#";
    kick.addEventListener("click", e=>{ e.preventDefault(); state.omega -= 1.5; });
    row.append(kick);
    ui.append(row);

    function draw(c, ctx, dt){
      ctx.clearRect(0,0,c.width,c.height);
      ctx.fillStyle="#0b121e"; ctx.fillRect(0,0,c.width,c.height);
      // pivot
      const origin = new Vec2(c.width/2, 80);
      const px = origin.x + Math.sin(state.theta) * state.L * 120;
      const py = origin.y + Math.cos(state.theta) * state.L * 120;

      // integrate
      const alpha = -(state.g/state.L)*Math.sin(state.theta) - state.damping*state.omega;
      state.omega += alpha * dt;
      state.theta += state.omega * dt;

      // draw rod
      ctx.strokeStyle="rgba(255,255,255,.3)"; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(px,py); ctx.stroke();
      // bob
      ctx.fillStyle="rgba(110,231,255,.9)";
      ctx.beginPath(); ctx.arc(px,py, 14, 0, TAU); ctx.fill();
      // pivot
      ctx.fillStyle="rgba(124,77,255,.9)";
      ctx.beginPath(); ctx.arc(origin.x, origin.y, 6, 0, TAU); ctx.fill();
    }

    canvasHandlers["sim-pendulum"] = new CanvasRunner(canvas, (c,ctx,dt)=> draw(c,ctx,dt), ()=>{});
  }

  // RC Circuit
  function initSimRC(){
    const canvas = $("#sim-rc"); if(!canvas) return;
    const ui = $("#rc-ui");
    const state = { R: 2000, C: 0.00047, V:5, t:0, charging:true, running:true };

    ui.innerHTML="";
    ui.append(sliderRow({ label:"Resistance", min:100, max:10000, step:50, value:state.R, unit:"Ω", onInput:v=> state.R=v }));
    ui.append(sliderRow({ label:"Capacitance", min:1e-6, max:0.01, step:1e-6, value:state.C, unit:"F", onInput:v=> state.C=v }));
    ui.append(sliderRow({ label:"Supply Voltage", min:1, max:12, step:.5, value:state.V, unit:"V", onInput:v=> state.V=v }));
    const row = createEl("div","row");
    const mode = createEl("a","btn","Toggle Charge/Discharge"); mode.href="#";
    mode.addEventListener("click", e=>{ e.preventDefault(); state.charging = !state.charging; state.t = 0; });
    const reset = createEl("a","btn","Reset"); reset.href="#";
    reset.addEventListener("click", e=>{ e.preventDefault(); state.t=0; });
    row.append(mode, reset);
    ui.append(row);

    function Vc(t){
      const tau = state.R * state.C;
      if(state.charging) return state.V * (1 - Math.exp(-t/tau));
      else return state.V * Math.exp(-t/tau);
    }

    function draw(c, ctx, dt){
      ctx.clearRect(0,0,c.width,c.height);
      ctx.fillStyle="#0b121e"; ctx.fillRect(0,0,c.width,c.height);
      // axes
      ctx.strokeStyle="rgba(255,255,255,.15)";
      ctx.beginPath(); ctx.moveTo(40,c.height-40); ctx.lineTo(c.width-20, c.height-40); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(40,c.height-40); ctx.lineTo(40, 20); ctx.stroke();

      const tau = state.R*state.C;
      ctx.fillStyle="rgba(255,255,255,.8)"; ctx.font="600 14px Inter";
      ctx.fillText(`τ = R·C = ${(tau).toFixed(3)} s`, 50, 30);

      ctx.save();
      ctx.translate(40, c.height-40);
      const scaleX = 120; // px per second
      const scaleY = 20;  // px per volt
      ctx.strokeStyle="rgba(110,231,255,.9)"; ctx.lineWidth=2;
      ctx.beginPath();
      for(let t=0;t< (c.width-60)/scaleX; t+=0.01){
        const y = Vc(t);
        const px = t*scaleX; const py = -y*scaleY;
        if(t===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
      }
      ctx.stroke();
      // marker
      const y = Vc(state.t);
      ctx.fillStyle="#fff";
      ctx.beginPath(); ctx.arc(state.t*scaleX, -y*scaleY, 4, 0, TAU); ctx.fill();

      ctx.restore();

      state.t += dt;
    }

    canvasHandlers["sim-rc"] = new CanvasRunner(canvas, (c,ctx,dt)=> draw(c,ctx,dt), ()=>{});
  }

  // Wave Interference
  function initSimWaves(){
    const canvas = $("#sim-waves"); if(!canvas) return;
    const ui = $("#waves-ui");
    const state = { lambda: 40, spacing: 120, k: 2*Math.PI/40, running:true, t:0, speed: 60 };

    ui.innerHTML="";
    ui.append(sliderRow({ label:"Wavelength", min:20, max:80, step:1, value:state.lambda, unit:"px", onInput:v=>{ state.lambda=v; state.k=2*Math.PI/state.lambda; } }));
    ui.append(sliderRow({ label:"Source Spacing", min:60, max:200, step:2, value:state.spacing, unit:"px", onInput:v=> state.spacing=v }));
    ui.append(sliderRow({ label:"Wave Speed", min:20, max:120, step:2, value:state.speed, unit:"px/s", onInput:v=> state.speed=v }));

    function draw(c, ctx, dt){
      ctx.clearRect(0,0,c.width,c.height);
      const w=c.width, h=c.height;
      ctx.fillStyle="#0b121e"; ctx.fillRect(0,0,w,h);

      const s1 = new Vec2(w*0.35, h*0.5 - state.spacing/2);
      const s2 = new Vec2(w*0.35, h*0.5 + state.spacing/2);
      const omega = 2*Math.PI*state.speed/state.lambda;

      const img = ctx.getImageData(0,0,w,h);
      const data = img.data;
      let i=0;
      for(let y=0;y<h;y++){
        for(let x=0;x<w;x++, i+=4){
          const r1 = Math.hypot(x - s1.x, y - s1.y);
          const r2 = Math.hypot(x - s2.x, y - s2.y);
          const phase = state.k*(r1 + r2) - omega*state.t;
          // intensity from interference
          const I = 0.5 + 0.5*Math.cos(phase);
          const col = Math.floor(lerp(16, 220, I));
          data[i]   = 64;
          data[i+1] = col;
          data[i+2] = 255;
          data[i+3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      // source markers
      ctx.fillStyle="rgba(255,255,255,.8)";
      ctx.beginPath(); ctx.arc(s1.x, s1.y, 5, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(s2.x, s2.y, 5, 0, TAU); ctx.fill();

      state.t += dt;
    }

    canvasHandlers["sim-waves"] = new CanvasRunner(canvas, (c,ctx,dt)=> draw(c,ctx,dt), ()=>{});
  }

  // ============== Boot ==============
  function boot(){
    initTabs();
    initHomeOrbit();

    // Games
    initGameGlider();
    initGameTorque();
    initGameOptics();

    // Simulations
    initSimProjectile();
    initSimPendulum();
    initSimRC();
    initSimWaves();

    // Start only visible canvases
    onPanelActivated("home");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();