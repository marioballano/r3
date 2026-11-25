#include "r3engine.h"
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

bool r3_frame_resize(R3Frame *f, int width, int height) {
	if (width < 1 || height < 1 || width > 4096 || height > 4096) {
		return false;
	}
	if (f->width == width && f->height == height) {
		return true;
	}
	size_t n = (size_t)width * height;
	if (n > SIZE_MAX / sizeof (R3Color) || n > INT_MAX / 3) {
		return false;
	}
	R3Frame next = { .width = width, .height = height, .camera = f->camera };
	next.color = calloc (n, sizeof (R3Color));
	next.bloom = calloc (n, sizeof (R3Color));
	next.scratch = calloc (n, sizeof (R3Color));
	next.depth = malloc (n * sizeof (float));
	next.object = calloc (n, sizeof (uint32_t));
	next.rgb = malloc (n * 3);
	if (!next.color || !next.bloom || !next.scratch || !next.depth || !next.object || !next.rgb) {
		r3_frame_free (&next);
		return false;
	}
	r3_frame_free (f);
	*f = next;
	return true;
}

void r3_frame_free(R3Frame *f) {
	free (f->color);
	free (f->bloom);
	free (f->scratch);
	free (f->depth);
	free (f->object);
	free (f->rgb);
	memset (f, 0, sizeof (*f));
}

void r3_frame_clear(R3Frame *f, R3Color color) {
	size_t n = (size_t)f->width * f->height;
	for (size_t i = 0; i < n; i++) {
		f->color[i] = color;
		f->depth[i] = FLT_MAX;
		f->object[i] = 0;
	}
}

static void pixel(R3Frame *f, int x, int y, float z, R3Color color, bool additive, uint32_t object) {
	if (x < 0 || y < 0 || x >= f->width || y >= f->height || !isfinite (z)) {
		return;
	}
	size_t at = (size_t)y * f->width + x;
	if (z > f->depth[at] * 1.006f) {
		return;
	}
	if (additive) {
		f->color[at].r += color.r;
		f->color[at].g += color.g;
		f->color[at].b += color.b;
	} else {
		f->color[at] = color;
		f->depth[at] = z;
	}
	if (object) {
		f->object[at] = object;
	}
}

typedef struct { R3Vertex vertex; float z, x, y; } ClipVertex;

static ClipVertex interpolate(ClipVertex a, ClipVertex b, float t) {
	ClipVertex v = {0};
	v.vertex.position = r3_lerp (a.vertex.position, b.vertex.position, t);
	v.vertex.normal = r3_lerp (a.vertex.normal, b.vertex.normal, t);
	v.vertex.u = a.vertex.u + (b.vertex.u - a.vertex.u) * t;
	v.vertex.v = a.vertex.v + (b.vertex.v - a.vertex.v) * t;
	v.z = a.z + (b.z - a.z) * t;
	return v;
}

static int clip_plane(const ClipVertex *in, int count, ClipVertex *out, float plane, bool near) {
	int n = 0;
	ClipVertex a = in[count - 1];
	bool inside_a = near? a.z >= plane: a.z <= plane;
	for (int i = 0; i < count; i++) {
		ClipVertex b = in[i];
		bool inside_b = near? b.z >= plane: b.z <= plane;
		if (inside_a != inside_b) {
			out[n++] = interpolate (a, b, (plane - a.z) / (b.z - a.z));
		}
		if (inside_b) {
			out[n++] = b;
		}
		a = b;
		inside_a = inside_b;
	}
	return n;
}

static float edge(ClipVertex a, ClipVertex b, float x, float y) {
	return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

static void raster_triangle(R3Frame *f, ClipVertex a, ClipVertex b, ClipVertex c, R3Shader shader, const void *uniforms, uint32_t object) {
	float area = edge (a, b, c.x, c.y);
	if (!isfinite (area) || fabsf (area) < 1e-6f) {
		return;
	}
	float left = fminf (a.x, fminf (b.x, c.x));
	float right = fmaxf (a.x, fmaxf (b.x, c.x));
	float top = fminf (a.y, fminf (b.y, c.y));
	float bottom = fmaxf (a.y, fmaxf (b.y, c.y));
	if (right < 0 || bottom < 0 || left >= f->width || top >= f->height) {
		return;
	}
	int x0 = (int)r3_clamp (floorf (left), 0, f->width - 1);
	int x1 = (int)r3_clamp (ceilf (right), 0, f->width - 1);
	int y0 = (int)r3_clamp (floorf (top), 0, f->height - 1);
	int y1 = (int)r3_clamp (ceilf (bottom), 0, f->height - 1);
	for (int y = y0; y <= y1; y++) {
		for (int x = x0; x <= x1; x++) {
			float wa = edge (b, c, x + .5f, y + .5f) / area;
			float wb = edge (c, a, x + .5f, y + .5f) / area;
			float wc = 1 - wa - wb;
			if (wa < -1e-5f || wb < -1e-5f || wc < -1e-5f) {
				continue;
			}
			wa /= a.z;
			wb /= b.z;
			wc /= c.z;
			float z = 1 / (wa + wb + wc);
			size_t at = (size_t)y * f->width + x;
			if (z >= f->depth[at]) {
				continue;
			}
			wa *= z;
			wb *= z;
			wc *= z;
			R3Fragment frag = {
				.position = r3_add (r3_add (r3_scale (a.vertex.position, wa), r3_scale (b.vertex.position, wb)), r3_scale (c.vertex.position, wc)),
				.normal = r3_normalize (r3_add (r3_add (r3_scale (a.vertex.normal, wa), r3_scale (b.vertex.normal, wb)), r3_scale (c.vertex.normal, wc))),
				.u = a.vertex.u * wa + b.vertex.u * wb + c.vertex.u * wc,
				.v = a.vertex.v * wa + b.vertex.v * wb + c.vertex.v * wc,
				.depth = z
			};
			pixel (f, x, y, z, shader (&frag, uniforms), false, object);
		}
	}
}

void r3_triangle(R3Frame *f, R3Vertex a, R3Vertex b, R3Vertex c, R3Shader shader, const void *uniforms, uint32_t object) {
	if (!f->color || !shader) {
		return;
	}
	ClipVertex in[8] = {{ .vertex = a }, { .vertex = b }, { .vertex = c }}, out[8];
	for (int i = 0; i < 3; i++) {
		in[i].z = r3_dot (r3_sub (in[i].vertex.position, f->camera.eye), f->camera.forward);
		if (!isfinite (in[i].z)) {
			return;
		}
	}
	int n = clip_plane (in, 3, out, f->camera.near_clip, true);
	if (n < 3) {
		return;
	}
	n = clip_plane (out, n, in, f->camera.far_clip, false);
	if (n < 3) {
		return;
	}
	for (int i = 0; i < n; i++) {
		// Clipped points can round a few ulps behind the near plane.
		R3Vec p = r3_sub (in[i].vertex.position, f->camera.eye);
		float focal = 1 / tanf (f->camera.fov * .00872664626f);
		in[i].x = (.5f + r3_dot (p, f->camera.right) * focal / (2 * in[i].z * f->camera.aspect)) * f->width;
		in[i].y = (.5f - r3_dot (p, f->camera.up) * focal / (2 * in[i].z)) * f->height;
		if (!isfinite (in[i].x) || !isfinite (in[i].y)) {
			return;
		}
	}
	for (int i = 1; i < n - 1; i++) {
		raster_triangle (f, in[0], in[i], in[i + 1], shader, uniforms, object);
	}
}

static bool clip_parameter(float p, float q, float *low, float *high) {
	if (fabsf (p) < 1e-8f) {
		return q >= 0;
	}
	float t = q / p;
	if (p < 0) {
		*low = fmaxf (*low, t);
	} else {
		*high = fminf (*high, t);
	}
	return *low <= *high;
}

void r3_line(R3Frame *f, R3Vec a, R3Vec b, R3Color color, float width, bool additive, uint32_t object) {
	float za = r3_dot (r3_sub (a, f->camera.eye), f->camera.forward);
	float zb = r3_dot (r3_sub (b, f->camera.eye), f->camera.forward);
	float low = 0, high = 1, dz = zb - za;
	if (!isfinite (za) || !isfinite (zb) || !clip_parameter (-dz, za - f->camera.near_clip - .0001f, &low, &high)
		|| !clip_parameter (dz, f->camera.far_clip - za - .0001f, &low, &high)) {
		return;
	}
	R3Vec start = r3_lerp (a, b, low), end = r3_lerp (a, b, high);
	float ax, ay, az, bx, by, bz;
	if (!r3_project (f, start, &ax, &ay, &az) || !r3_project (f, end, &bx, &by, &bz)) {
		return;
	}
	float dx = bx - ax, dy = by - ay;
	low = 0;
	high = 1;
	if (!clip_parameter (-dx, ax, &low, &high) || !clip_parameter (dx, f->width - 1 - ax, &low, &high)
		|| !clip_parameter (-dy, ay, &low, &high) || !clip_parameter (dy, f->height - 1 - ay, &low, &high)) {
		return;
	}
	float length = fmaxf (fabsf (dx), fabsf (dy)) * (high - low);
	int steps = (int)ceilf (fminf (length, f->width + f->height)) + 1;
	int radius = (int)r3_clamp (width * .5f, 0, 5);
	for (int i = 0; i <= steps; i++) {
		float t = low + (high - low) * i / steps;
		float z = 1 / ((1 - t) / az + t / bz);
		int x = (int)roundf (ax + t * dx), y = (int)roundf (ay + t * dy);
		for (int sy = -radius; sy <= radius; sy++) {
			for (int sx = -radius; sx <= radius; sx++) {
				pixel (f, x + sx, y + sy, z, color, additive, object);
			}
		}
	}
}

void r3_point(R3Frame *f, R3Vec point, R3Color color, float radius, bool additive, uint32_t object) {
	float x, y, z;
	if (!r3_project (f, point, &x, &y, &z) || x < -8 || y < -8 || x > f->width + 8 || y > f->height + 8) {
		return;
	}
	int extent = (int)r3_clamp (ceilf (radius), 0, 8);
	for (int dy = -extent; dy <= extent; dy++) {
		for (int dx = -extent; dx <= extent; dx++) {
			float weight = extent? expf (-(dx * dx + dy * dy) / fmaxf (.3f, radius * radius)): 1;
			pixel (f, (int)roundf (x) + dx, (int)roundf (y) + dy, z, r3_color_scale (color, weight), additive, object);
		}
	}
}

static void blur(const R3Color *source, R3Color *dest, int width, int height, bool vertical) {
	for (int y = 0; y < height; y++) {
		for (int x = 0; x < width; x++) {
			R3Color sum = {0};
			for (int d = -2; d <= 2; d++) {
				int sx = vertical? x: (int)r3_clamp (x + d, 0, width - 1);
				int sy = vertical? (int)r3_clamp (y + d, 0, height - 1): y;
				R3Color c = source[(size_t)sy * width + sx];
				sum.r += c.r; sum.g += c.g; sum.b += c.b;
			}
			dest[(size_t)y * width + x] = r3_color_scale (sum, .2f);
		}
	}
}

static uint8_t channel(float value, float scale) {
	return (uint8_t)(255 * sqrtf (r3_clamp (value * scale, 0, 1)));
}

void r3_frame_finish(R3Frame *f, float bloom_strength, float exposure) {
	size_t n = (size_t)f->width * f->height;
	if (bloom_strength > 0) {
		for (size_t i = 0; i < n; i++) {
			R3Color c = f->color[i];
			float peak = fmaxf (c.r, fmaxf (c.g, c.b));
			f->bloom[i] = r3_color_scale (c, peak > .7f? (peak - .7f) / peak: 0);
		}
		blur (f->bloom, f->scratch, f->width, f->height, false);
		blur (f->scratch, f->bloom, f->width, f->height, true);
	}
	for (size_t i = 0; i < n; i++) {
		R3Color c = f->color[i], b = f->bloom[i];
		c.r = fmaxf (0, c.r + b.r * bloom_strength);
		c.g = fmaxf (0, c.g + b.g * bloom_strength);
		c.b = fmaxf (0, c.b + b.b * bloom_strength);
		// A shared scale keeps bright saturated lights from turning white.
		float scale = fmaxf (0, exposure) / (1 + fmaxf (c.r, fmaxf (c.g, c.b)) * fmaxf (0, exposure));
		f->rgb[i * 3] = channel (c.r, scale);
		f->rgb[i * 3 + 1] = channel (c.g, scale);
		f->rgb[i * 3 + 2] = channel (c.b, scale);
	}
}
