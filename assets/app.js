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
    // Use CSS pixel dimensions to keep drawing coordinates consistent
    this.c.width  = Math.floor(rect.width);
    this.c.height = Math.floor(rect.height);
    // Reset any transforms; keep a 1:1 coordinate system
    this.ctx.setTransform(1,0,0,1,0,0);
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
