#include "r3c.h"
#include <r_util/r_utf8.h>
#include <ctype.h>
#include <math.h>

static uint32_t packed(R3Color color) {
	return ((uint32_t)r3_clamp (color.r * 255, 0, 255) << 16)
		| ((uint32_t)r3_clamp (color.g * 255, 0, 255) << 8) | (uint32_t)r3_clamp (color.b * 255, 0, 255);
}

static uint32_t indexed_color(int color);

const char *image_mode_name(int mode) {
	switch (mode) {
	case 'b': return "braille";
	case 'B': return "mono-braille";
	case 'r': return "rgb";
	case 'A': return "ansi";
	case '2': return "256";
	case 'g': return "gray";
	case 'c': return "ascii";
	case 'a': return "mono";
	default: return "unknown";
	}
}

static const char *text_style(const char *text, uint32_t *foreground, uint32_t *background, uint32_t default_fg, uint32_t default_bg) {
	int values[16] = {0}, count = 1;
	const char *p = text + 2;
	while (*p && *p != 'm' && (isdigit ((unsigned char)*p) || *p == ';')) {
		if (*p == ';') { if (count < 16) { count++; } }
		else { values[count - 1] = R_MIN (10000, values[count - 1] * 10 + *p - '0'); }
		p++;
	}
	if (*p != 'm') { return text + 1; }
	for (int i = 0; i < count; i++) {
		int v = values[i];
		if (v == 0) { *foreground = default_fg; *background = default_bg; }
		else if (v == 39) { *foreground = default_fg; }
		else if (v == 49) { *background = default_bg; }
		else if (v >= 30 && v <= 37) { *foreground = indexed_color (v - 30); }
		else if (v >= 90 && v <= 97) { *foreground = indexed_color (v - 90 + 8); }
		else if (v >= 40 && v <= 47) { *background = indexed_color (v - 40); }
		else if (v >= 100 && v <= 107) { *background = indexed_color (v - 100 + 8); }
		else if ((v == 38 || v == 48) && i + 2 < count) {
			uint32_t color;
			if (values[i + 1] == 2 && i + 4 < count) {
				color = ((uint32_t)(values[i + 2] & 255) << 16) | ((uint32_t)(values[i + 3] & 255) << 8) | (values[i + 4] & 255);
				i += 4;
			} else if (values[i + 1] == 5) {
				color = indexed_color (R_MIN (255, values[i + 2]));
				i += 2;
			} else { continue; }
			if (v == 38) { *foreground = color; } else { *background = color; }
		}
	}
	return p + 1;
}

void terminal_free(Terminal *t) {
	free (t->cells); free (t->previous); free (t->occupied);
	memset (t, 0, sizeof (*t));
}

bool terminal_resize(App *a, int width, int height) {
	width = R_MIN (1024, R_MAX (2, width - (a->snapshot? 0: 1)));
	height = R_MIN (512, R_MAX (2, height));
	int panel = a->inspector && width >= 90? R_MIN (width - 30, a->sidebar_width? a->sidebar_width: width * 45 / 100): 0;
	int scene_width = width - panel;
	int scene_rows = R_MAX (1, height - 4);
	Terminal *t = &a->terminal;
	if (t->width == width && t->height == height && t->scene_width == scene_width && a->frame.width == scene_width * image_xscale (a)) { return true; }
	size_t n = (size_t)width * height;
	Terminal next = { .width = width, .height = height, .scene_width = scene_width, .scene_rows = scene_rows, .repaint = true };
	next.cells = calloc (n, sizeof (Cell));
	next.previous = calloc (n, sizeof (Cell));
	next.occupied = calloc (n, 1);
	if (!next.cells || !next.previous || !next.occupied || !r3_frame_resize (&a->frame, scene_width * image_xscale (a), scene_rows * image_yscale (a))) {
		terminal_free (&next);
		return false;
	}
	terminal_free (t);
	*t = next;
	return true;
}

static const char *text_line(App *a, int x, int y, const char *text, uint32_t *fg, uint32_t *bg, uint32_t default_fg, uint32_t default_bg, int limit) {
	Terminal *t = &a->terminal;
	int used = 0;
	const ut8 *p = (const ut8 *)text, *end = p + strcspn (text, "\n");
	while (p < end) {
		if (p[0] == 27 && p + 1 < end && p[1] == '[') { p = (const ut8 *)text_style ((const char *)p, fg, bg, default_fg, default_bg); continue; }
		RRune ch = 0;
		int bytes = r_utf8_decode (p, R_MIN (4, end - p), &ch);
		if (bytes < 1) { bytes = 1; ch = '?'; }
		if (ch < 32 || ch == 127) { ch = ' '; }
		ut8 encoded[5] = {0};
		int encoded_length = r_utf8_encode (encoded, ch);
		encoded[encoded_length] = 0;
		int columns = R_MAX (1, r_utf8_display_width (encoded));
		if (y >= 0 && y < t->height && x >= 0 && columns <= limit - used && x + columns <= t->width) {
			size_t at = (size_t)y * t->width + x;
			t->cells[at] = (Cell){ch, *fg, *bg};
			t->occupied[at] = 1;
			for (int i = 1; i < columns; i++) { t->cells[at + i] = (Cell){0, *fg, *bg}; t->occupied[at + i] = 1; }
		}
		x += columns; used += columns; p += bytes;
	}
	return (const char *)end + (*end == '\n');
}

void terminal_text(App *a, int x, int y, const char *text, R3Color color, int limit) {
	if (!text || y < 0 || y >= a->terminal.height) { return; }
	uint32_t fg = packed (color), bg = 0x02030a;
	text_line (a, x, y, text, &fg, &bg, fg, bg, limit);
}

void terminal_label(App *a, R3Vec point, uint32_t object, const char *text, R3Color color, bool priority) {
	float sx, sy, depth;
	if (!text || !r3_project (&a->frame, point, &sx, &sy, &depth)) { return; }
	if (sx < 0 || sy < 0 || sx >= a->frame.width || sy >= a->frame.height) { return; }
	int x = (int)(sx / image_xscale (a)), y = (int)(sy / image_yscale (a)) + 2;
	Terminal *t = &a->terminal;
	int length = R_MIN (priority? 40: 23, r_utf8_display_width ((const ut8 *)text));
	x -= length / 2;
	if (x < 0 || x + length >= t->scene_width || y < 2 || y >= 2 + t->scene_rows) { return; }
	int px = (int)sx, py = (int)sy;
	if (px < 0 || py < 0 || px >= a->frame.width || py >= a->frame.height) { return; }
	size_t pixel = (size_t)py * a->frame.width + px;
	if (!priority && depth > a->frame.depth[pixel] * 1.025f && a->frame.object[pixel] != object) { return; }
	for (int i = x; i < x + length; i++) {
		if (!priority && t->occupied[(size_t)y * t->width + i]) { return; }
	}
	terminal_text (a, x, y, text, color, length);
}

static const uint32_t ansi_palette[16] = {0x000000, 0xaa0000, 0x00aa00, 0xaa5500, 0x0000aa, 0xaa00aa, 0x00aaaa, 0xaaaaaa,
	0x555555, 0xff5555, 0x55ff55, 0xffff55, 0x5555ff, 0xff55ff, 0x55ffff, 0xffffff};

static uint32_t indexed_color(int color) {
	if (color < 16) { return ansi_palette[R_MAX (0, color)]; }
	if (color >= 232) { unsigned v = 8 + R_MIN (23, color - 232) * 10; return (v << 16) | (v << 8) | v; }
	static const unsigned levels[] = {0, 95, 135, 175, 215, 255};
	color -= 16;
	return (levels[color / 36] << 16) | (levels[(color / 6) % 6] << 8) | levels[color % 6];
}

static void parse_image(App *a, const char *image) {
	Terminal *t = &a->terminal;
	uint32_t fg = 0xffffff, bg = 0;
	int x = 0, y = 2;
	const ut8 *p = (const ut8 *)image;
	const ut8 *end = p + strlen (image);
	while (*p && y < t->height - 2) {
		if (p[0] == 27 && p[1] == '[') {
			p = (const ut8 *)text_style ((const char *)p, &fg, &bg, 0xffffff, 0);
			continue;
		}
		if (*p == '\n') { x = 0; y++; p++; continue; }
		RRune rune = 0;
		int bytes = r_utf8_decode (p, R_MIN (4, end - p), &rune);
		if (bytes < 1) { bytes = 1; rune = '?'; }
		if (x < t->scene_width) { t->cells[(size_t)y * t->width + x] = (Cell){rune, fg, bg}; }
		x++; p += bytes;
	}
}

static void inspector(App *a) {
	Terminal *t = &a->terminal;
	if (t->scene_width == t->width) { return; }
	int left = t->scene_width, width = t->width - left;
	uint32_t bg = a->themed? a->inspector_background: 0x02030a;
	int luminance = (((bg >> 16) & 255) * 3 + ((bg >> 8) & 255) * 6 + (bg & 255)) / 10;
	uint32_t default_fg = luminance > 140? 0x161616: 0xcccccc, fg = default_fg;
	for (int y = 2; y < t->height - 2; y++) {
		for (int x = left; x < t->width; x++) {
			size_t at = (size_t)y * t->width + x;
			t->cells[at] = (Cell){x == left? '|': ' ', default_fg, bg};
			t->occupied[at] = 1;
		}
	}
	uint32_t heading = packed (app_color (a, 1));
	const char *tabs[] = {"DISASSEMBLY", "PSEUDO C", "XREFS", "FUNCTION INFO", "R2 OUTPUT"};
	text_line (a, left + 2, 2, tabs[R_MIN (4, a->inspector_tab)], &heading, &bg, default_fg, bg, width - 3);
	text_line (a, left + 2, 3, "[/] resize  {/} tab  J/K scroll", &fg, &bg, default_fg, bg, width - 3);
	char address[40];
	snprintf (address, sizeof (address), "0x%" PFMT64x, a->address);
	const char *title = a->address_mode? address: a->selected >= 0? a->model.functions[a->selected].name: "";
	text_line (a, left + 2, 5, title, &fg, &bg, default_fg, bg, width - 3);
	uint32_t default_bg = bg;
	const char *line = a->inspection? a->inspection: "No function selected";
	for (int i = 0; i < a->scroll && *line; i++) { line = text_line (a, 0, -1, line, &fg, &bg, default_fg, default_bg, 0); }
	for (int y = 7; y < t->height - 3 && *line; y++) {
		line = text_line (a, left + 2, y, line, &fg, &bg, default_fg, default_bg, width - 3);
	}
}

static void world_text(App *a) {
	R3Color cyan = scene_color (1), selected = scene_color (5);
	if (a->view == VIEW_CFG) {
		for (size_t i = 0; i < a->graph.count; i++) {
			Block *b = &a->graph.blocks[i];
			R3Vec top = r3_add (b->position, r3_vec (0, b->height * .5f - .8f, .05f));
			float x1, y1, z1, x2, y2, z2;
			if (!r3_project (&a->frame, r3_add (top, r3_vec (-b->width * .5f, 0, 0)), &x1, &y1, &z1)
				|| !r3_project (&a->frame, r3_add (top, r3_vec (b->width * .5f, -b->height, 0)), &x2, &y2, &z2)) { continue; }
			char title[64];
			snprintf (title, sizeof (title), "%s0x%" PFMT64x, (int)i == a->selected_block? "> ": "", b->addr);
			terminal_label (a, top, (uint32_t)i + 1, title, (int)i == a->selected_block? selected: cyan, (int)i == a->selected_block);
			int width = (int)(fabsf (x2 - x1) / image_xscale (a)) - 2;
			int x = (int)(fminf (x1, x2) / image_xscale (a)) + 1, y = (int)(y1 / image_yscale (a)) + 3;
			int lines = (int)(fabsf (y2 - y1) / image_yscale (a)) - 2;
			if (width < 12 || lines < 1 || x < 0 || x + width >= a->terminal.scene_width) { continue; }
			for (size_t j = 0; j < b->op_count && (int)j < lines; j++) {
				char text[256];
				snprintf (text, sizeof (text), "%c %s", (int)i == a->selected_block && (int)j == a->instruction? '>': ' ', b->ops[j].text);
				terminal_text (a, x, y + (int)j, text, (int)i == a->selected_block && (int)j == a->instruction? selected: cyan, width);
			}
		}
		return;
	}
	if (a->labels && a->selected >= 0) {
		Function *f = &a->model.functions[a->selected];
		R3Vec point = r3_add (f->position, r3_vec (0, a->view == VIEW_CITY? f->height + 2: 7, 0));
		terminal_label (a, point, (uint32_t)a->selected + 1, f->name, selected, true);
	}
	if (a->entropy && a->model.entropy_count && a->view == VIEW_CITY) {
		R3Vec facing = r3_normalize (r3_vec (a->frame.camera.eye.x, 0, a->frame.camera.eye.z));
		R3Vec label = r3_add (r3_scale (facing, a->model.radius + 55), r3_vec (0, 18, 0));
		terminal_label (a, label, 0, "ENTROPY", entropy_color (.75f), true);
	}
	int budget = 35;
	for (size_t i = 0; i < a->model.count && budget; i++) {
		if (!a->labels || (a->labels == 1 && a->hops[i] > a->focus_depth)) { continue; }
		if ((int)i == a->selected || (a->hops[i] > a->focus_depth && i % R_MAX (1, a->model.count / 15))) { continue; }
		Function *f = &a->model.functions[i];
		if (a->view == VIEW_GRAPH && (!a->roles[i] || a->hops[i] > a->focus_depth)) { continue; }
		terminal_label (a, r3_add (f->position, r3_vec (0, a->view == VIEW_CITY? f->height + 1: 4, 0)), (uint32_t)i + 1, f->name, cyan, false);
		budget--;
	}
	if (a->selected >= 0 && a->view == VIEW_CITY) {
		int line = 0;
		for (size_t i = 0; i < a->model.string_ref_count && line < 4; i++) {
			StringRef ref = a->model.string_refs[i];
			if (ref.function != a->selected) { continue; }
			Function *f = &a->model.functions[a->selected];
			terminal_label (a, r3_add (f->position, r3_vec (12, f->height * .5f + line++ * 5, 0)), 0, a->model.strings[ref.string].text, r3_color (.5f, 1, .4f), false);
		}
	}
}

bool terminal_compose(App *a) {
	Terminal *t = &a->terminal;
	size_t n = (size_t)t->width * t->height;
	for (size_t i = 0; i < n; i++) { t->cells[i] = (Cell){' ', 0xb0d8e8, 0x02030a}; }
	memset (t->occupied, 0, n);
	// Preserve RGB until the final terminal encoding; r_cons_image's A mode uses only eight colors.
	int mode = a->image_mode == 'A' || a->image_mode == '2'? 'r': a->image_mode;
	char *image = r_cons_image (a->frame.rgb, a->frame.width * a->frame.height * 3, a->frame.width, mode, 3);
	if (!image) { return false; }
	parse_image (a, image);
	free (image);
	world_text (a);
	inspector (a);
	char header[512];
	const char *name = a->view == VIEW_CITY? "CITY": a->view == VIEW_GRAPH? "CONSTELLATION": "CONTROL FLOW";
	snprintf (header, sizeof (header), "r3c / %s / %s  %s  %zu functions / %zu links  %s%d", name, image_mode_name (a->image_mode), a->model.arch? a->model.arch: "", a->model.count, a->model.call_count, a->drone? "FLY ": "", a->model.bits);
	terminal_text (a, 1, 1, header, scene_color (1), t->width - 2);
	snprintf (header, sizeof (header), "%s%s", a->backend.endpoint? "HTTP / ": "", a->model.title? a->model.title: "");
	terminal_text (a, 1, 0, header, scene_color (3), t->width - 2);
	terminal_text (a, 1, t->height - 2, "hjkl move  n/p select  Enter CFG  c graph  H city  i inspect  m mode  R theme  , settings  / search  q quit", r3_color (.35f, .6f, .7f), t->width - 2);
	if (a->prompt_mode) {
		snprintf (header, sizeof (header), "%s %s", a->prompt_mode == 1? "/": a->prompt_mode == 3? "goto address:": ":", a->prompt);
	} else if (*a->message) {
		snprintf (header, sizeof (header), "%s", a->message);
	} else if (a->selected >= 0) {
		Function *f = &a->model.functions[a->selected];
		snprintf (header, sizeof (header), "%s  0x%" PFMT64x " / %" PFMT64u " bytes / %d blocks / depth %d%s", f->name, f->addr, f->size, f->nbbs, a->focus_depth, a->paused? " / PAUSED": "");
	} else {
		snprintf (header, sizeof (header), "No functions found. Use :aa then Ctrl-R to refresh.");
	}
	terminal_text (a, 1, t->height - 1, header, r3_color (1, .8f, .35f), t->width - 2);
	if (a->prompt_mode == 1 && *a->prompt) {
		int y = t->height - 4, count = 0;
		for (size_t i = 0; i < a->model.count && count < 6; i++) {
			if (r_str_casestr (a->model.functions[i].name, a->prompt)) {
				terminal_text (a, 3, y - count++, a->model.functions[i].name, r3_color (.8f, 1, 1), t->scene_width - 6);
			}
		}
	}
	if (a->help) {
		const char *lines[] = {
			"R3C / THE BINARY IS THE WORLD", "",
			"hjkl / arrows     orbit; CFG: walk branches",
			"mouse drag        orbit; right drag: pan",
			"click / double    select / enter function",
			"vertical wheel    zoom; horizontal: orbit",
			". / 0             reset camera / reset zoom",
			"Tab / Shift-Tab   next / previous function",
			"n / p             next / previous in city",
			"c / H / Enter     constellation / city / CFG",
			"f then WASD e/x   fly, rise / descend",
			"1 2 3             neighbourhood depth",
			"J/K or PgDn/PgUp  scroll inspector 10 lines",
			"i / x             inspector / xrefs",
			"[ / ]             move sidebar divider",
			"{ / }             previous / next tab",
			"b / B             history back / forward",
			"t / Space         orbit tour / pause effects",
			"m / M / ,         next/previous mode / settings",
			"g / / / :         address / search / r2 command",
			"R / Ctrl-R        next r2 theme / reload",
			"Esc               leave view or cancel",
			"q / Ctrl-C        confirm quit", NULL
		};
		int left = R_MAX (1, (t->width - 48) / 2), top = R_MAX (2, (t->height - 24) / 2);
		for (int i = 0; lines[i] && top + i < t->height - 2; i++) {
			terminal_text (a, left, top + i, "                                                ", r3_color (0, 0, 0), 48);
			terminal_text (a, left + 1, top + i, lines[i], r3_color (.6f, 1, 1), 46);
		}
	}
	if (a->settings) {
		const char *names[] = {"Textures", "Bloom", "Fog", "Ambient links", "Ground grid", "Stars", "Particles", "Labels", "Visual effects", "Entropy halo"};
		bool values[] = {a->textures, a->bloom_enabled, a->fog, a->ambient_links, a->grid, a->stars, a->particles, false, a->effects, a->entropy};
		int left = R_MAX (1, (t->width - 44) / 2), top = R_MAX (2, (t->height - 15) / 2);
		terminal_text (a, left, top, "RENDER SETTINGS / , or Esc to close", r3_color (.2f, 1, 1), 43);
		for (int i = 0; i < 10; i++) {
			char line[64];
			const char *value = i == 7? (a->labels == 0? "none": a->labels == 1? "focus": "all"): values[i]? "on": "off";
			snprintf (line, sizeof (line), "%c %-21s %-10s", i == a->settings_row? '>': ' ', names[i], value);
			terminal_text (a, left, top + i + 2, line, i == a->settings_row? r3_color (1, .85f, .3f): r3_color (.7f, .9f, 1), 43);
		}
		terminal_text (a, left, top + 13, "j/k select    h/l or Space change", r3_color (.4f, .7f, .8f), 43);
	}
	if (a->confirm_quit) {
		int x = R_MAX (0, t->width / 2 - 19), y = t->height / 2;
		terminal_text (a, x, y - 1, "                                      ", r3_color (0, 0, 0), 38);
		terminal_text (a, x, y, "       Quit r3c? [y/N]                 ", r3_color (1, .85f, .3f), 38);
		terminal_text (a, x, y + 1, "                                      ", r3_color (0, 0, 0), 38);
	}
	return true;
}

static void output_color(int mode, RStrBuf *out, uint32_t color, bool background) {
	int r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
	if (mode == 'A') {
		int best = 0, distance = INT_MAX;
		for (int i = 0; i < 16; i++) {
			int dr = r - (int)((ansi_palette[i] >> 16) & 255), dg = g - (int)((ansi_palette[i] >> 8) & 255), db = b - (int)(ansi_palette[i] & 255);
			int d = dr * dr + dg * dg + db * db;
			if (d < distance) { distance = d; best = i; }
		}
		r_strbuf_appendf (out, "\x1b[%dm", (background? 40: 30) + best % 8 + (best >= 8? 60: 0));
	} else if (mode == '2') {
		int index;
		if (r == g && g == b) { index = 232 + R_MIN (23, (r + g + b) / 3 / 11); }
		else {
			int channels[] = {r, g, b}, cube[3] = {0};
			for (int c = 0; c < 3; c++) { int best = 256; for (int i = 0; i < 6; i++) { int d = abs (channels[c] - (i? 55 + i * 40: 0)); if (d < best) { best = d; cube[c] = i; } } }
			index = 16 + cube[0] * 36 + cube[1] * 6 + cube[2];
		}
		r_strbuf_appendf (out, "\x1b[%d;5;%dm", background? 48: 38, index);
	} else {
		r_strbuf_appendf (out, "\x1b[%d;2;%d;%d;%dm", background? 48: 38, r, g, b);
	}
}

void terminal_present(App *a) {
	Terminal *t = &a->terminal;
	RStrBuf out;
	r_strbuf_init (&out);
	bool colors = !(a->snapshot && a->plain);
	if (!a->snapshot && t->repaint) { r_strbuf_append (&out, "\x1b[2J"); }
	uint32_t foreground = UINT32_MAX, background = UINT32_MAX;
	int previous_mode = -1;
	for (int y = 0; y < t->height; y++) {
		int first = 0, last = t->width - 1;
		if (!a->snapshot && !t->repaint) {
			while (first <= last && !memcmp (&t->cells[(size_t)y * t->width + first], &t->previous[(size_t)y * t->width + first], sizeof (Cell))) { first++; }
			while (last >= first && !memcmp (&t->cells[(size_t)y * t->width + last], &t->previous[(size_t)y * t->width + last], sizeof (Cell))) { last--; }
			if (first > 0 && first <= last && !t->cells[(size_t)y * t->width + first].ch) { first--; }
		}
		if (first > last) { continue; }
		if (!a->snapshot) { r_strbuf_appendf (&out, "\x1b[%d;%dH", y + 1, first + 1); }
		for (int x = first; x <= last; x++) {
			size_t at = (size_t)y * t->width + x;
			Cell cell = t->cells[at];
			if (!cell.ch) { continue; }
			if (colors) {
				int mode = t->occupied[at]? 'r': a->image_mode;
				if (mode != previous_mode) { foreground = background = UINT32_MAX; previous_mode = mode; }
				if (cell.foreground != foreground) { output_color (mode, &out, cell.foreground, false); foreground = cell.foreground; }
				if (cell.background != background) { output_color (mode, &out, cell.background, true); background = cell.background; }
			}
			ut8 glyph[4];
			int length = r_utf8_encode (glyph, cell.ch);
			r_strbuf_append_n (&out, (const char *)glyph, length);
		}
		if (a->snapshot) { r_strbuf_append (&out, "\n"); }
	}
	if (colors) { r_strbuf_append (&out, Color_RESET); }
	r_cons_print (a->cons, r_strbuf_get (&out));
	if (!a->snapshot) { r_cons_flush (a->cons); }
	r_strbuf_fini (&out);
	memcpy (t->previous, t->cells, (size_t)t->width * t->height * sizeof (Cell));
	t->repaint = false;
}
