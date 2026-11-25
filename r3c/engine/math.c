#include "r3engine.h"
#include <math.h>

R3Vec r3_vec(float x, float y, float z) { return (R3Vec){x, y, z}; }
R3Vec r3_add(R3Vec a, R3Vec b) { return r3_vec (a.x + b.x, a.y + b.y, a.z + b.z); }
R3Vec r3_sub(R3Vec a, R3Vec b) { return r3_vec (a.x - b.x, a.y - b.y, a.z - b.z); }
R3Vec r3_scale(R3Vec a, float s) { return r3_vec (a.x * s, a.y * s, a.z * s); }
R3Vec r3_lerp(R3Vec a, R3Vec b, float t) { return r3_add (a, r3_scale (r3_sub (b, a), t)); }
float r3_dot(R3Vec a, R3Vec b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
float r3_length(R3Vec a) { return sqrtf (r3_dot (a, a)); }
R3Vec r3_normalize(R3Vec a) { float d = r3_length (a); return d > 1e-8f? r3_scale (a, 1 / d): r3_vec (0, 0, 0); }
R3Vec r3_cross(R3Vec a, R3Vec b) { return r3_vec (a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
R3Color r3_color(float r, float g, float b) { return (R3Color){r, g, b}; }
R3Color r3_color_scale(R3Color a, float s) { return r3_color (a.r * s, a.g * s, a.b * s); }
R3Color r3_color_mix(R3Color a, R3Color b, float t) { return r3_color (a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t); }
float r3_clamp(float x, float low, float high) { return fminf (high, fmaxf (low, x)); }
float r3_smooth(float low, float high, float x) { float t = r3_clamp ((x - low) / (high - low), 0, 1); return t * t * (3 - 2 * t); }
float r3_hash(uint32_t x) { x ^= x >> 16; x *= 0x7feb352d; x ^= x >> 15; x *= 0x846ca68b; x ^= x >> 16; return (x & 0xffffff) / 16777215.f; }

void r3_camera_look(R3Camera *c, R3Vec eye, R3Vec target, float fov, float aspect) {
	c->eye = eye;
	c->target = target;
	c->forward = r3_normalize (r3_sub (target, eye));
	if (r3_length (c->forward) < 0.5f) {
		c->forward = r3_vec (0, 0, -1);
	}
	R3Vec up = fabsf (c->forward.y) > 0.999f? r3_vec (0, 0, 1): r3_vec (0, 1, 0);
	c->right = r3_normalize (r3_cross (c->forward, up));
	c->up = r3_cross (c->right, c->forward);
	c->fov = r3_clamp (fov, 5, 150);
	c->aspect = fmaxf (0.01f, aspect);
	c->near_clip = 0.2f;
	c->far_clip = 20000;
}

bool r3_project(const R3Frame *f, R3Vec point, float *x, float *y, float *depth) {
	R3Vec p = r3_sub (point, f->camera.eye);
	float z = r3_dot (p, f->camera.forward);
	if (!isfinite (z) || z < f->camera.near_clip || z > f->camera.far_clip) {
		return false;
	}
	float focal = 1 / tanf (f->camera.fov * 0.00872664626f);
	*x = (0.5f + r3_dot (p, f->camera.right) * focal / (2 * z * f->camera.aspect)) * f->width;
	*y = (0.5f - r3_dot (p, f->camera.up) * focal / (2 * z)) * f->height;
	*depth = z;
	return isfinite (*x) && isfinite (*y);
}

R3Color r3_texture_sample(const R3Texture *texture, float u, float v) {
	if (!texture || !texture->rgb || texture->width < 1 || texture->height < 1 || !isfinite (u) || !isfinite (v)) {
		return r3_color (1, 1, 1);
	}
	int x = (int)((u - floorf (u)) * texture->width);
	int y = (int)((v - floorf (v)) * texture->height);
	size_t at = ((size_t)y * texture->width + x) * 3;
	return r3_color (texture->rgb[at] / 255.f, texture->rgb[at + 1] / 255.f, texture->rgb[at + 2] / 255.f);
}
