#include "r3engine.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>

static R3Color solid(const R3Fragment *fragment, const void *uniforms) {
	(void)fragment;
	return *(const R3Color *)uniforms;
}

static R3Vertex vertex(float x, float y, float z) {
	return (R3Vertex){r3_vec (x, y, z), r3_vec (0, 0, 1), 0, 0};
}

int main(void) {
	R3Frame frame = {0};
	assert (r3_frame_resize (&frame, 80, 60));
	r3_camera_look (&frame.camera, r3_vec (0, 0, 5), r3_vec (0, 0, 0), 60, 80.f / 60);
	float x, y, depth;
	assert (r3_project (&frame, r3_vec (0, 0, 0), &x, &y, &depth));
	assert (fabsf (x - 40) < .001f && fabsf (y - 30) < .001f && fabsf (depth - 5) < .001f);
	assert (!r3_project (&frame, r3_vec (0, 0, 6), &x, &y, &depth));
	r3_frame_clear (&frame, r3_color (0, 0, 0));
	R3Color red = r3_color (1, 0, 0), blue = r3_color (0, 0, 1);
	r3_triangle (&frame, vertex (-2, -2, 0), vertex (2, -2, 0), vertex (0, 2, 0), solid, &red, 7);
	size_t center = 30 * 80 + 40;
	assert (frame.object[center] == 7 && frame.color[center].r == 1);
	r3_triangle (&frame, vertex (-2, -2, -1), vertex (2, -2, -1), vertex (0, 2, -1), solid, &blue, 8);
	assert (frame.object[center] == 7);
	r3_triangle (&frame, vertex (-2, -2, 1), vertex (2, -2, 1), vertex (0, 2, 1), solid, &blue, 9);
	assert (frame.object[center] == 9 && frame.color[center].b == 1);
	r3_frame_clear (&frame, r3_color (0, 0, 0));
	r3_triangle (&frame, vertex (-1, -1, 4.9f), vertex (1, -1, 0), vertex (0, 1, 0), solid, &red, 3);
	int visible = 0;
	for (int i = 0; i < 80 * 60; i++) { visible += frame.object[i] == 3; }
	assert (visible > 0);
	r3_line (&frame, r3_vec (-1e8f, 0, 0), r3_vec (1e8f, 0, 0), red, 1, true, 0);
	r3_line (&frame, r3_vec (0, 0, 6), r3_vec (0, 1, 7), red, 1, true, 0);
	r3_frame_finish (&frame, .8f, 1);
	assert (frame.rgb[center * 3] > 0);
	frame.color[center] = r3_color (100, 1, .1f);
	r3_frame_finish (&frame, 0, 1);
	assert (frame.rgb[center * 3] > 250 && frame.rgb[center * 3 + 1] < 30 && frame.rgb[center * 3 + 2] < 10);
	R3Color *old = frame.color;
	assert (!r3_frame_resize (&frame, -1, 20) && frame.color == old);
	assert (r3_frame_resize (&frame, 33, 17));
	assert (frame.width == 33 && frame.height == 17);
	r3_frame_free (&frame);
	assert (!frame.color && !frame.depth && !frame.object);
	const uint8_t pixels[] = {255, 0, 0, 0, 255, 0};
	R3Texture texture = {pixels, 2, 1};
	assert (r3_texture_sample (&texture, .1f, 0).r == 1);
	assert (r3_texture_sample (&texture, -.1f, 0).g == 1);
	assert (r3_texture_sample (&texture, 1.1f, 0).r == 1);
	puts ("engine: projection, depth, clipping, resize and textures passed");
	return 0;
}
