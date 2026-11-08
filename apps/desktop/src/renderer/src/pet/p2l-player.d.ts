// SPDX-License-Identifier: AGPL-3.0-only
// Type surface of the vendored PSD2Live web player (vendor/p2l/p2l.js, MIT)
// that the pet renderer uses. Only what we call is declared.

declare module '*/vendor/p2l/p2l.js' {
  /** Raw exports of the runtime's WebAssembly instance (C ABI). */
  export type P2lRuntimeExports = WebAssembly.Exports & {
    p2l_clip_finished(rig: number): number
    p2l_clip_playing(rig: number): number
  }

  export class P2LPlayer {
    static fromBytes(
      canvas: HTMLCanvasElement,
      runtime: WebAssembly.Exports,
      bytes: Uint8Array,
    ): Promise<P2LPlayer>
    readonly rt: P2lRuntimeExports
    readonly rig: number
    readonly gl: WebGLRenderingContext
    readonly clips: string[]
    readonly expressions: string[]
    readonly parameters: string[]
    play(id: string | null): void
    expression(id: string | null): void
    lookAt(x: number, y: number): void
    lipSync(level: number): void
    behaviors(flags: number): void
    setParameter(id: string, value: number): void
    update(dt: number): void
    draw(): void
    stop(): void
    dispose(): void
  }
}

declare module '*.wasm?url&inline' {
  /** The file as a base64 data: URL (Vite explicit inline). */
  const dataUrl: string
  export default dataUrl
}
