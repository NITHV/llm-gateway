// Tiny Prometheus-style metrics store. Only counters, plus sum/count pairs for latency.
export class Metrics {
  constructor() {
    this.counters = new Map();
  }

  inc(name, labels = {}, by = 1) {
    const k = keyOf(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  // Record a duration in seconds as <name>_seconds_sum and <name>_seconds_count.
  observe(name, labels, seconds) {
    this.inc(`${name}_seconds_sum`, labels, seconds);
    this.inc(`${name}_seconds_count`, labels, 1);
  }

  render() {
    let out = '';
    for (const [k, v] of this.counters) out += `${k} ${v}\n`;
    return out;
  }
}

function keyOf(name, labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  return `${name}{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}
