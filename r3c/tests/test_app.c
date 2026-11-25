#include "r3c.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>

static void release(App *a) {
	free (a->inspection); free (a->roles); free (a->hops);
	model_free (&a->model);
	graph_free (&a->graph);
	terminal_free (&a->terminal);
	r3_frame_free (&a->frame);
	backend_close (&a->backend);
	r_cons_free (a->cons);
}

static void framebuffer_colors(void) {
	App a = {.cons = r_cons_new (), .snapshot = true, .selected = -1};
	const char *modes = "rbc";
	for (const char *mode = modes; *mode; mode++) {
		a.image_mode = *mode;
		assert (terminal_resize (&a, 80, 24));
		for (int y = 0; y < a.frame.height; y++) {
			for (int x = 0; x < a.frame.width; x++) {
				ut8 *rgb = a.frame.rgb + ((size_t)y * a.frame.width + x) * 3;
				rgb[0] = y % 2? 6: 220; rgb[1] = y % 2? 44: 12; rgb[2] = y % 2? 198: 34;
			}
		}
		assert (terminal_compose (&a));
		Cell cell = a.terminal.cells[10 * a.terminal.width + 10];
		if (*mode == 'c') { assert (cell.foreground == 0x711c74 && cell.ch < 128); }
		else {
			assert (cell.foreground == 0xdc0c22 && cell.background == 0x062cc6);
			assert (*mode == 'r'? cell.ch == 0x2580: cell.ch >= 0x2800 && cell.ch <= 0x28ff);
		}
	}
	terminal_text (&a, 0, 0, "\x1b[0;38;2;12;34;56;48;2;78;90;123mRGB\x1b[0m!", r3_color (1, 1, 1), 20);
	assert (a.terminal.cells[0].foreground == 0x0c2238 && a.terminal.cells[0].background == 0x4e5a7b);
	assert (a.terminal.cells[3].foreground == 0xffffff);
	a.inspector = true;
	a.inspection = strdup ("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\x1b[38;2;231;42;123mCOLORED\nCONTINUED\n");
	for (const char *mode = "bgacBrA2"; *mode; mode++) {
		a.image_mode = *mode;
		assert (terminal_resize (&a, 120, 24));
		memset (a.frame.rgb, 80, (size_t)a.frame.width * a.frame.height * 3);
		assert (terminal_compose (&a));
		Cell cell = a.terminal.cells[8 * a.terminal.width + a.terminal.scene_width + 2];
		assert (cell.foreground == 0xe72a7b);
		r_cons_push (a.cons);
		terminal_present (&a);
		char *output = r_cons_drain (a.cons, NULL);
		r_cons_pop (a.cons);
		assert (output && strstr (output, "\x1b[38;2;231;42;123m"));
		free (output);
	}
	a.scroll = 1;
	assert (terminal_compose (&a));
	assert (a.terminal.cells[7 * a.terminal.width + a.terminal.scene_width + 2].foreground == 0xe72a7b);
	a.inspector = false;
	a.image_mode = 'A';
	assert (terminal_resize (&a, 80, 24));
	for (size_t i = 0; i < (size_t)a.frame.width * a.frame.height; i++) {
		a.frame.rgb[i * 3] = 255; a.frame.rgb[i * 3 + 1] = 85; a.frame.rgb[i * 3 + 2] = 85;
	}
	assert (terminal_compose (&a));
	assert (a.terminal.cells[10 * a.terminal.width + 10].foreground == 0xff5555);
	r_cons_push (a.cons);
	terminal_present (&a);
	char *ansi = r_cons_drain (a.cons, NULL);
	r_cons_pop (a.cons);
	assert (ansi && strstr (ansi, "\x1b[91m") && strstr (ansi, "\x1b[38;2;1;242;255m"));
	free (ansi);
	release (&a);
}

static void scene_and_controls(void) {
	App a = {.cons = r_cons_new (), .demo = true, .snapshot = true, .image_mode = 'b', .selected = 0,
		.focus_depth = 2, .running = true, .inspector = true, .entropy = true, .labels = 1, .history_cursor = -1};
	assert (model_demo (&a.model));
	a.roles = calloc (a.model.count, 1); a.hops = calloc (a.model.count, 1);
	assert (a.roles && a.hops);
	assert (terminal_resize (&a, 160, 50));
	assert (app_view (&a, VIEW_CITY, true));
	a.target = a.target_goal; a.distance = a.distance_goal;
	scene_update (&a, 10);
	a.entropy = false;
	scene_render (&a);
	size_t pixels = (size_t)a.frame.width * a.frame.height;
	ut8 *without = malloc (pixels * 3);
	assert (without);
	memcpy (without, a.frame.rgb, pixels * 3);
	a.entropy = true;
	scene_render (&a);
	size_t colored = 0;
	for (size_t i = 0; i < pixels; i++) {
		const ut8 *rgb = a.frame.rgb + i * 3;
		int high = R_MAX (rgb[0], R_MAX (rgb[1], rgb[2])), low = R_MIN (rgb[0], R_MIN (rgb[1], rgb[2]));
		if (memcmp (without + i * 3, rgb, 3) && high > 120 && high - low > 80) { colored++; }
	}
	assert (colored > 100);
	free (without);
	size_t calls = a.model.call_count;
	a.model.call_count = 0;
	scene_render (&a);
	without = malloc (pixels * 3);
	assert (without);
	memcpy (without, a.frame.rgb, pixels * 3);
	a.model.call_count = calls;
	scene_render (&a);
	size_t yellow = 0;
	for (size_t i = 0; i < pixels; i++) {
		const ut8 *rgb = a.frame.rgb + i * 3;
		if (memcmp (without + i * 3, rgb, 3) && rgb[0] > 220 && rgb[1] > 210 && rgb[2] < 80) { yellow++; }
	}
	assert (yellow > 5);
	free (without);
	assert (entropy_color (0).b > .9f && entropy_color (1).r > .9f && entropy_color (1).g < .05f);
	assert (terminal_compose (&a));
	int width = a.terminal.width - a.terminal.scene_width;
	app_key (&a, '[');
	assert (a.sidebar_width == width + 4);
	app_key (&a, ']');
	assert (a.sidebar_width == width);
	app_key (&a, '}'); assert (a.inspector_tab == 1);
	app_key (&a, '{'); assert (a.inspector_tab == 0);
	free (a.inspection);
	a.inspection = strdup ("0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n");
	app_key (&a, 'J'); assert (a.scroll == 10);
	app_key (&a, 'K'); assert (a.scroll == 0);
	app_key (&a, 'n'); assert (a.selected == 1);
	app_key (&a, 'p'); assert (a.selected == 0);
	app_key (&a, 'x'); assert (a.inspector && a.inspector_tab == 2);
	int mode = a.image_mode;
	app_key (&a, 'M'); assert (a.image_mode == 'B');
	app_key (&a, 'm'); assert (a.image_mode == mode);
	for (int i = 0; i < 8; i++) { app_key (&a, 'm'); }
	assert (a.image_mode == mode);
	for (int i = 0; i < 8; i++) { app_key (&a, 'M'); }
	assert (a.image_mode == mode);
	float yaw = a.yaw, distance = a.distance_goal;
	app_mouse (&a, 66, 10, 10, false);
	assert (a.yaw < yaw && a.distance_goal == distance);
	app_mouse (&a, 67, 10, 10, false);
	assert (fabsf (a.yaw - yaw) < .00001f && a.distance_goal == distance);
	app_mouse (&a, 64, 10, 10, false);
	assert (a.distance_goal < distance);
	a.yaw = 2; a.pitch = -.1f; a.target_goal = r3_vec (7, 8, 9);
	app_key (&a, '0');
	assert (a.distance == app_default_zoom (&a) && a.distance_goal == a.distance);
	assert (a.yaw == 2 && a.pitch == -.1f && a.target_goal.x == 7 && a.target_goal.z == 9);
	a.drone = a.tour = true;
	app_key (&a, '.');
	assert (!a.drone && !a.tour && a.yaw == .75f && a.pitch == .55f);
	assert (a.target.x == 0 && a.target.z == 0 && a.distance == a.distance_goal);
	app_key (&a, 'g'); assert (a.prompt_mode == 3);
	for (const char *p = "0x1004"; *p; p++) { app_key (&a, *p); }
	app_key (&a, '\r');
	assert (!a.prompt_mode && a.address_mode && a.address == 0x1004 && a.selected == 0);
	app_key (&a, 'n'); assert (!a.address_mode && a.selected == 1);
	app_key (&a, 'g'); app_key (&a, 'z'); app_key (&a, '\r');
	assert (!a.address_mode && strstr (a.message, "Invalid address"));
	assert (app_view (&a, VIEW_CFG, true));
	assert (a.graph.count && a.graph.route_count);
	for (size_t i = 0; i < a.graph.count; i++) {
		assert (a.graph.blocks[i].width > 0 && a.graph.blocks[i].height > 0);
		assert (isfinite (a.graph.blocks[i].position.x));
	}
	for (size_t i = 0; i < a.graph.route_count; i++) { assert (a.graph.routes[i].count >= 2); }
	assert (app_next_theme (&a) && a.themed);
	char previous[128];
	snprintf (previous, sizeof (previous), "%s", a.theme);
	assert (!strcmp (a.theme, r_core_get_theme (a.backend.core)));
	assert (app_next_theme (&a) && strcmp (previous, a.theme));
	app_key (&a, 'q'); assert (a.running && a.confirm_quit);
	app_key (&a, 'n'); assert (a.running && !a.confirm_quit);
	a.settings = true;
	app_key (&a, 3); assert (a.running && a.confirm_quit && !a.settings);
	app_key (&a, 27); assert (a.running && !a.confirm_quit);
	app_key (&a, 3); app_key (&a, 'y'); assert (!a.running);
	release (&a);
}

static void theme_disassembly(const char *path, bool remote) {
	App a = {.cons = r_cons_new (), .snapshot = true, .image_mode = 'b', .selected = -1, .inspector = true};
	assert (backend_open (&a.backend, remote? NULL: path, remote? path: NULL, remote? "none": "aa"));
	assert (model_load (&a.model, &a.backend));
	a.selected = model_find (&a.model, "main");
	assert (a.selected >= 0);
	assert (terminal_resize (&a, 160, 50));
	memset (a.frame.rgb, 0, (size_t)a.frame.width * a.frame.height * 3);
	r3_camera_look (&a.frame.camera, r3_vec (0, 0, 5), r3_vec (0, 0, 0), 60, 1);
	app_inspect (&a);
	assert (a.inspection && strstr (a.inspection, "0x") && strstr (a.inspection, "\x1b["));
	RJson *themes = backend_json (&a.backend, "ecoj");
	assert (themes && themes->type == R_JSON_ARRAY && themes->children.count);
	R3Color city_color = a.model.functions[a.selected].color;
	for (size_t i = 0; i <= themes->children.count; i++) {
		assert (app_next_theme (&a));
		assert (a.inspection && strstr (a.inspection, "0x") && strstr (a.inspection, "\x1b["));
		assert (!memcmp (&city_color, &a.model.functions[a.selected].color, sizeof (city_color)));
		assert (terminal_compose (&a));
		int visible = 0, colored = 0, readable = 0;
		for (int y = 7; y < a.terminal.height - 3; y++) {
			for (int x = a.terminal.scene_width + 2; x < a.terminal.width; x++) {
				Cell cell = a.terminal.cells[y * a.terminal.width + x];
				if (cell.ch <= ' ') { continue; }
				visible++;
				unsigned rgb = cell.foreground;
				if (((rgb >> 16) & 255) != ((rgb >> 8) & 255) || ((rgb >> 8) & 255) != (rgb & 255)) { colored++; }
				int contrast = 0;
				for (int shift = 0; shift <= 16; shift += 8) { contrast = R_MAX (contrast, abs ((int)((rgb >> shift) & 255) - (int)((cell.background >> shift) & 255))); }
				readable += contrast > 32;
			}
		}
		assert (visible > 100);
		assert (readable > visible / 2);
		bool chromatic = false;
		for (int key = 0; key < 8; key++) { chromatic |= a.palette[key].r != a.palette[key].g || a.palette[key].g != a.palette[key].b; }
		if (chromatic) { assert (colored > 20); }
		if (!strcmp (a.theme, "white") || !strcmp (a.theme, "white2")) { assert (a.inspector_background == 0xcccccc); }
	}
	a.scroll = 100000;
	assert (app_next_theme (&a));
	assert (a.scroll < 1000);
	r_json_free (themes);
	char address[32];
	snprintf (address, sizeof (address), "0x%" PFMT64x, a.model.functions[a.selected].addr + 4);
	app_key (&a, 'g');
	for (const char *p = address; *p; p++) { app_key (&a, *p); }
	app_key (&a, '\r');
	assert (a.address_mode && a.address == strtoull (address, NULL, 0));
	char *seek = backend_command (&a.backend, "s");
	assert (seek && strtoull (seek, NULL, 0) == a.address);
	free (seek);
	assert (app_next_theme (&a));
	assert (a.inspection && strstr (a.inspection, "0x") && strstr (a.inspection, "\x1b["));
	release (&a);
}

int main(int argc, char **argv) {
	if (argc == 3 && !strcmp (argv[1], "--http")) {
		theme_disassembly (argv[2], true);
		puts ("HTTP: disassembly across all r2 themes and address navigation passed");
		return 0;
	}
	framebuffer_colors ();
	scene_and_controls ();
	assert (argc == 2);
	theme_disassembly (argv[1], false);
	puts ("app: RGB/Braille colors, ANSI text, entropy, native layout, themes and controls passed");
	return 0;
}
