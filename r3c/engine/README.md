# r3engine

A reusable software 3D renderer in C99. Its dependencies are the C standard library and `libm`. It has no radare2, terminal, windowing or browser dependencies.

Compile `math.c` and `renderer.c`, include `r3engine.h`, and link with `-lm`:

```sh
cc -std=c99 -Iengine tests/test_engine.c engine/math.c engine/renderer.c -lm -o /tmp/r3engine-test
/tmp/r3engine-test
```

`R3Frame` owns an HDR color buffer, depth buffer, object IDs, bloom work buffers and packed RGB output. Zero-initialize it before use. `r3_frame_resize` preserves the previous frame if allocation fails; `r3_frame_free` releases everything.

A frame follows this sequence:

1. Resize with `r3_frame_resize` and set the camera with `r3_camera_look`.
2. Clear with `r3_frame_clear`.
3. Draw triangles, lines and points with `r3_triangle`, `r3_line` and `r3_point`.
4. Finish with `r3_frame_finish` to apply optional bloom, hue-preserving tone mapping and RGB conversion.
5. Consume `frame.rgb` with an image writer or any display backend.

Triangle vertices carry world positions, normals and UV coordinates. A fragment shader is an ordinary `R3Shader` callback taking interpolated attributes and a caller-owned uniform pointer. Triangles are clipped at the near and far planes and interpolated with perspective correction. Lines are clipped to the view and framebuffer. Object IDs and depth can be used for picking or to occlude text labels rendered by the host application.

`r3_texture_sample` samples a caller-owned packed RGB texture with wrapped UV coordinates and nearest-neighbor filtering. The frontend supplies its lighting, procedural windows, fog and animation in `scene.c`; the engine supplies rasterization and postprocessing. Character conversion and native text overlays belong to `terminal.c`, outside this directory.
