import { BufferAttribute, BufferGeometry } from "three";

/** A point on a cross-section of the book, seen from above, with its outward normal and how far along its texture it is. */
export interface Ring {
  x: number;
  z: number;
  nx: number;
  nz: number;
  u: number;
}

export const ring = (x: number, z: number, nx: number, nz: number, u: number): Ring => ({ x, z, nx, nz, u });

type Point = readonly [x: number, z: number];

/**
 * Triangles, normals and texture coordinates, a list of triangles per material. Texture coordinates are given as a
 * picture has them, v = 0 at its top, and turned over for the graphics card as the geometry is made.
 */
export class Mesh {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private elements: number[][] = [];

  /** A new part of the mesh, with a material of its own. */
  element(): number {
    this.elements.push([]);
    return this.elements.length - 1;
  }

  private vertex(x: number, y: number, z: number, n: readonly [number, number, number], u: number, v: number): number {
    const len = Math.max(1e-6, Math.hypot(n[0], n[1], n[2]));
    this.positions.push(x, y, z);
    this.normals.push(n[0] / len, n[1] / len, n[2] / len);
    this.uvs.push(u, 1 - v);
    return this.positions.length / 3 - 1;
  }

  /** A cross-section swept up from y0 to y1; v runs from v0 at y0 to v1 at y1 (the texture's top is 0). */
  strip(e: number, section: readonly Ring[], y0: number, y1: number, v0 = 1, v1 = 0): void {
    for (let i = 0; i < section.length - 1; i++) {
      const p = section[i]!, q = section[i + 1]!;
      if (p.x === q.x && p.z === q.z) continue;
      const a = this.vertex(p.x, y0, p.z, [p.nx, 0, p.nz], p.u, v0), b = this.vertex(q.x, y0, q.z, [q.nx, 0, q.nz], q.u, v0);
      const c = this.vertex(q.x, y1, q.z, [q.nx, 0, q.nz], q.u, v1), d = this.vertex(p.x, y1, p.z, [p.nx, 0, p.nz], p.u, v1);
      this.elements[e]!.push(a, b, c, a, c, d);
    }
  }

  /** A softened edge: the cross-section at `from`, drawn in by `inset` at `to`, its normals halfway between the side and the top. */
  chamfer(e: number, section: readonly Ring[], inset: number, from: number, to: number, vFrom: number, vTo: number): void {
    const up = to > from ? 1 : -1;
    const moved = (p: Ring) => {
      const n = Math.max(1e-6, Math.hypot(p.nx, p.nz));
      return { x: p.x - (p.nx / n) * inset, z: p.z - (p.nz / n) * inset, nx: p.nx / n, nz: p.nz / n };
    };
    for (let i = 0; i < section.length - 1; i++) {
      const p = section[i]!, q = section[i + 1]!;
      if (p.x === q.x && p.z === q.z) continue;
      const pi = moved(p), qi = moved(q);
      const a = this.vertex(p.x, from, p.z, [pi.nx, up, pi.nz], p.u, vFrom), b = this.vertex(q.x, from, q.z, [qi.nx, up, qi.nz], q.u, vFrom);
      const c = this.vertex(qi.x, to, qi.z, [qi.nx, up, qi.nz], q.u, vTo), d = this.vertex(pi.x, to, pi.z, [pi.nx, up, pi.nz], p.u, vTo);
      this.elements[e]!.push(a, b, c, a, c, d);
    }
  }

  /** A flat quad, given its corners as (x, z) at height y. */
  cap(e: number, corners: readonly Point[], y: number, up: boolean): void {
    const ids = corners.map((c) => this.vertex(c[0], y, c[1], [0, up ? 1 : -1, 0], 0, 0));
    this.elements[e]!.push(ids[0]!, ids[1]!, ids[2]!, ids[0]!, ids[2]!, ids[3]!);
  }

  /** A vertical wall between two points of the cross-section. */
  wall(e: number, p: Point, q: Point, y0: number, y1: number, normal: Point): void {
    const n = [normal[0], 0, normal[1]] as const;
    const a = this.vertex(p[0], y0, p[1], n, 0, 0), b = this.vertex(q[0], y0, q[1], n, 1, 0);
    const c = this.vertex(q[0], y1, q[1], n, 1, 1), d = this.vertex(p[0], y1, p[1], n, 0, 1);
    this.elements[e]!.push(a, b, c, a, c, d);
  }

  /** The flat band between two curves of the same number of points, at height y. */
  band(e: number, outer: readonly Point[], inner: readonly Point[], y: number, up: boolean): void {
    const n = [0, up ? 1 : -1, 0] as const;
    for (let i = 0; i < outer.length - 1; i++) {
      const a = this.vertex(outer[i]![0], y, outer[i]![1], n, 0, 0), b = this.vertex(outer[i + 1]![0], y, outer[i + 1]![1], n, 0, 0);
      const c = this.vertex(inner[i + 1]![0], y, inner[i + 1]![1], n, 0, 0), d = this.vertex(inner[i]![0], y, inner[i]![1], n, 0, 0);
      this.elements[e]!.push(a, b, c, a, c, d);
    }
  }

  /** A flat face filling a closed outline, fanned from its middle. */
  fan(e: number, outline: readonly Point[], y: number, up: boolean, u: (x: number) => number, v: (z: number) => number): void {
    const n = [0, up ? 1 : -1, 0] as const;
    const cx = outline.reduce((sum, p) => sum + p[0], 0) / outline.length, cz = outline.reduce((sum, p) => sum + p[1], 0) / outline.length;
    const centre = this.vertex(cx, y, cz, n, u(cx), v(cz));
    const ids = outline.map((p) => this.vertex(p[0], y, p[1], n, u(p[0]), v(p[1])));
    for (let i = 0; i < ids.length; i++) this.elements[e]!.push(centre, ids[i]!, ids[(i + 1) % ids.length]!);
  }

  /** The geometry, its parts in the order they were made: part i takes material i. */
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.positions), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(this.normals), 3));
    g.setAttribute("uv", new BufferAttribute(new Float32Array(this.uvs), 2));
    const index: number[] = [];
    this.elements.forEach((triangles, material) => {
      g.addGroup(index.length, triangles.length, material);
      for (const i of triangles) index.push(i);
    });
    g.setIndex(index);
    return g;
  }
}
