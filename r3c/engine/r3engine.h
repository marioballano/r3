#ifndef R3_ENGINE_H
#define R3_ENGINE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct { float x, y, z; } R3Vec;
typedef struct { float r, g, b; } R3Color;
typedef struct { R3Vec position, normal; float u, v; } R3Vertex;
typedef struct { R3Vec position, normal; float u, v, depth; } R3Fragment;
typedef R3Color (*R3Shader)(const R3Fragment *fragment, const void *uniforms);

typedef struct {
	R3Vec eye, target, right, up, forward;
	float fov, aspect, near_clip, far_clip;
} R3Camera;

typedef struct {
	int width, height;
	R3Color *color, *bloom, *scratch;
	float *depth;
	uint32_t *object;
	uint8_t *rgb;
	R3Camera camera;
} R3Frame;

typedef struct { const uint8_t *rgb; int width, height; } R3Texture;

R3Vec r3_vec(float x, float y, float z);
R3Vec r3_add(R3Vec a, R3Vec b);
R3Vec r3_sub(R3Vec a, R3Vec b);
R3Vec r3_scale(R3Vec a, float s);
R3Vec r3_lerp(R3Vec a, R3Vec b, float t);
float r3_dot(R3Vec a, R3Vec b);
float r3_length(R3Vec a);
R3Vec r3_normalize(R3Vec a);
R3Vec r3_cross(R3Vec a, R3Vec b);
R3Color r3_color(float r, float g, float b);
R3Color r3_color_scale(R3Color a, float s);
R3Color r3_color_mix(R3Color a, R3Color b, float t);
float r3_clamp(float x, float low, float high);
float r3_smooth(float low, float high, float x);
float r3_hash(uint32_t value);

void r3_camera_look(R3Camera *camera, R3Vec eye, R3Vec target, float fov, float aspect);
bool r3_project(const R3Frame *frame, R3Vec point, float *x, float *y, float *depth);
bool r3_frame_resize(R3Frame *frame, int width, int height);
void r3_frame_free(R3Frame *frame);
void r3_frame_clear(R3Frame *frame, R3Color color);
void r3_triangle(R3Frame *frame, R3Vertex a, R3Vertex b, R3Vertex c, R3Shader shader, const void *uniforms, uint32_t object);
void r3_line(R3Frame *frame, R3Vec a, R3Vec b, R3Color color, float width, bool additive, uint32_t object);
void r3_point(R3Frame *frame, R3Vec point, R3Color color, float radius, bool additive, uint32_t object);
void r3_frame_finish(R3Frame *frame, float bloom_strength, float exposure);
R3Color r3_texture_sample(const R3Texture *texture, float u, float v);

#endif
