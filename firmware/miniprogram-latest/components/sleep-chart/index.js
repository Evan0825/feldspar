const { paintChart, pickChartPoint } = require('../../domain/sleep-data-chart')
Component({
  properties: { kind: { type: String, value: 'night' }, chart: { type: Object, value: null } },
  observers: { 'kind,chart': function () { if (this._ready) this.draw() } },
  lifetimes: { ready() { this._ready = true; this.draw() }, detached() { this._ready = false; this._drawId = (this._drawId || 0) + 1 } },
  methods: {
    draw() {
      const requestId = this._drawId = (this._drawId || 0) + 1
      this.createSelectorQuery().select('#plot').fields({ node: true, size: true }).exec(result => {
        if (!this._ready || requestId !== this._drawId || !result[0] || !result[0].node || !this.data.chart) return
        const { node, width, height } = result[0]
        if (!width || !height) return
        const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio
        node.width = width * dpr; node.height = height * dpr
        const context = node.getContext('2d'); context.scale(dpr, dpr)
        this._geometry = paintChart(context, this.data.kind, this.data.chart, width, height)
      })
    },
    selectPoint(event) {
      if (!this._geometry) return
      const touch = event.changedTouches && event.changedTouches[0]
      const x = touch && Number.isFinite(touch.x) ? touch.x : event.detail.x
      const point = pickChartPoint(this._geometry, x)
      if (point) this.triggerEvent('select', point)
    },
  },
})
