"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Decorative, dependency-free globe for the hero's empty space: a rotating
 * dotted Earth with great-circle shipping routes between international hubs and
 * pulses travelling along them. Rendered on a single Canvas 2D context and
 * paused entirely when the user prefers reduced motion.
 */

type Vec3 = { x: number; y: number; z: number };

const DEG = Math.PI / 180;

// Tilt the rotation axis a touch so the poles read as a sphere, not a disc.
const AXIS_TILT = -20 * DEG;
// Radians per second of spin (west -> east, a slow ~50s revolution).
const SPIN = (2 * Math.PI) / 50;

// Major international shipping hubs spread across every continent, so the spin
// always brings new connections into view. [lat, lng] in degrees.
const HUBS: ReadonlyArray<readonly [number, number]> = [
  [8.98, -79.52], // Panama City (home hub)
  [40.71, -74.01], // New York
  [34.05, -118.24], // Los Angeles
  [-23.55, -46.63], // Sao Paulo
  [51.51, -0.13], // London
  [6.52, 3.38], // Lagos
  [25.2, 55.27], // Dubai
  [19.08, 72.88], // Mumbai
  [1.35, 103.82], // Singapore
  [22.32, 114.17], // Hong Kong
  [35.68, 139.65], // Tokyo
  [-33.87, 151.21], // Sydney
  [-26.2, 28.05], // Johannesburg
];

// Routes drawn as arcs (indices into HUBS), forming a global mesh around Panama.
const ROUTES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // Panama -> New York
  [1, 4], // New York -> London
  [4, 6], // London -> Dubai
  [6, 7], // Dubai -> Mumbai
  [7, 8], // Mumbai -> Singapore
  [8, 9], // Singapore -> Hong Kong
  [9, 10], // Hong Kong -> Tokyo
  [10, 2], // Tokyo -> Los Angeles
  [2, 0], // Los Angeles -> Panama
  [4, 3], // London -> Sao Paulo
  [6, 12], // Dubai -> Johannesburg
  [8, 11], // Singapore -> Sydney
  [3, 5], // Sao Paulo -> Lagos
];

const ARC_SEGMENTS = 44;

function latLngToVec3(latDeg: number, lngDeg: number): Vec3 {
  const lat = latDeg * DEG;
  const lng = lngDeg * DEG;
  const cosLat = Math.cos(lat);
  return { x: cosLat * Math.sin(lng), y: Math.sin(lat), z: cosLat * Math.cos(lng) };
}

// Evenly spaced dots over the sphere: each latitude band holds a count
// proportional to its circumference, which reads as a clean wireframe globe.
function buildGlobeDots(): Vec3[] {
  const dots: Vec3[] = [];
  const latStep = 8;
  const equatorDots = 56;
  for (let lat = -84; lat <= 84; lat += latStep) {
    const count = Math.max(1, Math.round(equatorDots * Math.cos(lat * DEG)));
    for (let i = 0; i < count; i += 1) {
      dots.push(latLngToVec3(lat, -180 + (360 * i) / count));
    }
  }
  return dots;
}

// Great-circle arc between two unit vectors, bulged above the surface so routes
// float over the globe like flight paths. Spherical interpolation (slerp).
function buildArc(a: Vec3, b: Vec3): Vec3[] {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  const points: Vec3[] = [];
  for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
    const t = i / ARC_SEGMENTS;
    let p: Vec3;
    if (sinOmega < 1e-6) {
      p = a;
    } else {
      const s1 = Math.sin((1 - t) * omega) / sinOmega;
      const s2 = Math.sin(t * omega) / sinOmega;
      p = { x: a.x * s1 + b.x * s2, y: a.y * s1 + b.y * s2, z: a.z * s1 + b.z * s2 };
    }
    const lift = 1 + 0.18 * Math.sin(Math.PI * t);
    points.push({ x: p.x * lift, y: p.y * lift, z: p.z * lift });
  }
  return points;
}

function rotate(p: Vec3, sinR: number, cosR: number, sinT: number, cosT: number): Vec3 {
  // Spin about the vertical axis, then apply the fixed tilt about the X axis.
  const x = p.x * cosR + p.z * sinR;
  const z1 = -p.x * sinR + p.z * cosR;
  const y = p.y * cosT - z1 * sinT;
  const z = p.y * sinT + z1 * cosT;
  return { x, y, z };
}

export function HeroGlobe({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dots = buildGlobeDots();
    const hubs = HUBS.map(([lat, lng]) => latLngToVec3(lat, lng));
    const arcs = ROUTES.map(([from, to], index) => ({
      points: buildArc(hubs[from], hubs[to]),
      // Stagger the pulses so they don't all travel in lockstep.
      phase: (index * 0.37) % 1,
      speed: 0.16 + (index % 3) * 0.05,
    }));

    const sinT = Math.sin(AXIS_TILT);
    const cosT = Math.cos(AXIS_TILT);

    let width = 0;
    let height = 0;
    let cx = 0;
    let cy = 0;
    let radius = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = width / 2;
      cy = height / 2;
      radius = Math.min(width, height) * 0.42;
    };

    const drawAtmosphere = () => {
      const halo = ctx.createRadialGradient(cx, cy, radius * 0.6, cx, cy, radius * 1.55);
      halo.addColorStop(0, "rgba(99, 102, 241, 0.16)");
      halo.addColorStop(0.55, "rgba(79, 70, 229, 0.08)");
      halo.addColorStop(1, "rgba(79, 70, 229, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.55, 0, Math.PI * 2);
      ctx.fill();

      // Subtle volume with an off-centre light source (upper left).
      const body = ctx.createRadialGradient(
        cx - radius * 0.35,
        cy - radius * 0.4,
        radius * 0.1,
        cx,
        cy,
        radius * 1.05,
      );
      body.addColorStop(0, "rgba(67, 56, 202, 0.35)");
      body.addColorStop(1, "rgba(30, 27, 75, 0.12)");
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    };

    const draw = (rot: number, timeSec: number) => {
      ctx.clearRect(0, 0, width, height);
      if (radius <= 0) return;
      drawAtmosphere();

      const sinR = Math.sin(rot);
      const cosR = Math.cos(rot);
      const project = (p: Vec3) => {
        const r = rotate(p, sinR, cosR, sinT, cosT);
        return { sx: cx + r.x * radius, sy: cy - r.y * radius, depth: r.z };
      };

      // Globe dots, dimmer towards the back hemisphere for depth.
      for (const dot of dots) {
        const { sx, sy, depth } = project(dot);
        const front = (depth + 1) / 2;
        const alpha = 0.12 + front * 0.5;
        const size = 0.6 + front * 1.0;
        ctx.fillStyle = `rgba(165, 180, 252, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // Route arcs: fade each segment by depth so they wrap the visible side.
      ctx.lineWidth = 1.2;
      ctx.lineCap = "round";
      for (const arc of arcs) {
        for (let i = 1; i < arc.points.length; i += 1) {
          const a = project(arc.points[i - 1]);
          const b = project(arc.points[i]);
          const depth = (a.depth + b.depth) / 2;
          if (depth < -0.2) continue;
          const alpha = Math.max(0, Math.min(1, (depth + 0.2) / 1.2)) * 0.7;
          ctx.strokeStyle = `rgba(251, 191, 36, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
        }

        // Pulse travelling along the arc, like a parcel in transit.
        const tp = (timeSec * arc.speed + arc.phase) % 1;
        const idx = Math.min(arc.points.length - 1, Math.floor(tp * arc.points.length));
        const pulse = project(arc.points[idx]);
        if (pulse.depth > -0.05) {
          const a = Math.max(0, Math.min(1, (pulse.depth + 0.05) / 1.05));
          ctx.fillStyle = `rgba(253, 224, 71, ${(0.9 * a).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(pulse.sx, pulse.sy, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Hub nodes with a soft glow, hidden on the far side of the globe.
      for (const hub of hubs) {
        const { sx, sy, depth } = project(hub);
        if (depth < -0.05) continue;
        const front = Math.max(0, Math.min(1, (depth + 0.05) / 1.05));
        const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 7);
        glow.addColorStop(0, `rgba(253, 224, 71, ${(0.55 * front).toFixed(3)})`);
        glow.addColorStop(1, "rgba(253, 224, 71, 0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(sx, sy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255, 251, 235, ${(0.85 * front).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let frame = 0;
    let start = 0;

    const loop = (now: number) => {
      if (start === 0) start = now;
      const elapsed = (now - start) / 1000;
      draw(elapsed * SPIN, elapsed);
      frame = window.requestAnimationFrame(loop);
    };

    resize();
    const observer = new ResizeObserver(() => {
      resize();
      if (reduceMotion) draw(0.6, 0);
    });
    observer.observe(canvas);

    if (reduceMotion) {
      draw(0.6, 0);
    } else {
      frame = window.requestAnimationFrame(loop);
    }

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={canvasRef} className={cn("h-full w-full", className)} aria-hidden="true" />;
}
