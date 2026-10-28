"use strict";

// splitmix64 streams, one per (level, purpose), so adding a draw to one level
// never shifts another level's values.
//
// Port of vendor/SpektraLab-1.3.3/engine/src/pipeline/overscan.cpp `Rng` and
// `stream`. The C++ works in uint64_t; BigInt keeps this bit-exact instead of
// approximating 64-bit multiplication with 32-bit halves.

const MASK64 = (1n << 64n) - 1n;
const LEVEL = { film: 1, camera: 2, frame: 3 };

function u64(value) {
  return BigInt.asUintN(64, value);
}

function splitmixNext(state) {
  let s = u64(state + 0x9e3779b97f4a7c15n);
  let z = s;
  z = u64((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
  z = u64((z ^ (z >> 27n)) * 0x94d049bb133111ebn);
  return { state: s, value: u64(z ^ (z >> 31n)) };
}

class Rng {
  constructor(seed) {
    this.s = u64(BigInt(Math.trunc(Number(seed)) >>> 0 || 0) & MASK64);
  }

  next() {
    const step = splitmixNext(this.s);
    this.s = step.state;
    // The C++ keeps the low 64 bits; callers that need a uint32 take the low half.
    return step.value;
  }

  nextU32() {
    return Number(this.next() & 0xffffffffn);
  }

  /** `double(next() >> 11) * (1 / 9007199254740992)` — a double in [0, 1). */
  uni(a, b) {
    const value = Number(this.next() >> 11n) / 9007199254740992;
    if (a === undefined) return value;
    return a + (b - a) * value;
  }

  normal() {
    const u1 = Math.max(this.uni(), 1e-12);
    const u2 = this.uni();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

/** `stream(seed, level, purpose)` in overscan.cpp. `seed` may be a BigInt
 *  (callers pass `frm ^ (cam << 32)`) or a Number. */
function stream(seed, level, purpose) {
  const raw = typeof seed === "bigint" ? BigInt.asUintN(64, seed) : BigInt(Math.trunc(Number(seed)) >>> 0);
  const s = raw & MASK64;
  const lv = u64(BigInt(Math.trunc(Number(level))) << 40n);
  const pu = u64(BigInt(Math.trunc(Number(purpose))) << 20n);
  return Number(u64(u64(s * 0x9e3779b97f4a7c15n) ^ lv ^ pu ^ 0xd1b54a32d192ed03n));
}

module.exports = { Rng, stream, LEVEL };
