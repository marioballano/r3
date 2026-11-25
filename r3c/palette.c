#include "r3c.h"
#include <math.h>

static const R3Color neon[] = {
	{.008f, .08f, 1}, {.004f, .95f, 1}, {.02f, 1, .12f},
	{.38f, .008f, 1}, {1, .008f, .3f}, {1, .5f, .004f},
	{.02f, 1, .1f}, {1, .015f, .035f}
};

static R3Color gradient(const R3Color *colors, size_t count, float value) {
	float position = r3_clamp (value, 0, 1) * (count - 1);
	size_t index = R_MIN ((size_t)position, count - 2);
	return r3_color_mix (colors[index], colors[index + 1], position - index);
}

R3Color entropy_color(float value) {
	static const R3Color heat[] = {
		{.005f, .06f, 1}, {.003f, .95f, 1}, {.02f, 1, .02f}, {1, .8f, .002f}, {1, .008f, .015f}
	};
	return gradient (heat, R_ARRAY_SIZE (heat), value);
}

R3Color app_color(const App *a, int index) {
	index = R_MIN (7, R_MAX (0, index));
	return a->themed? a->palette[index]: neon[index];
}

R3Color scene_color(int index) {
	return neon[R_MIN (7, R_MAX (0, index))];
}

static uint32_t inspector_background(Backend *b) {
	if (b->core) {
		RColor color = r_cons_pal_get (b->core->cons, "widget.bg");
		if (color.a == ALPHA_FGBG) { return (color.r2 << 16) | (color.g2 << 8) | color.b2; }
		if (color.a == ALPHA_BG) { return (color.r << 16) | (color.g << 8) | color.b; }
	} else {
		char *script = backend_command (b, "ec*");
		const char *line = script;
		while (line && *line) {
			unsigned foreground, background;
			if (sscanf (line, "ec widget.bg rgb:%6x rgb:%6x", &foreground, &background) == 2) {
				free (script);
				return background;
			}
			line = strchr (line, '\n');
			if (line) { line++; }
		}
		free (script);
	}
	return 0x02030a;
}

void model_palette(Model *m, const R3Color *palette) {
	if (!palette) { palette = neon; }
	for (size_t i = 0; i < m->count; i++) {
		Function *f = &m->functions[i];
		f->color = f->imported? palette[5]: gradient (palette, 6, f->tint);
	}
}

static bool palette_entry(const RJson *json, const char *key, R3Color *color) {
	const RJson *array = json_field (json, key);
	if (!array || array->type != R_JSON_ARRAY || array->children.count < 3) { return false; }
	float channels[3];
	const RJson *value = array->children.first;
	for (int i = 0; i < 3; i++, value = value->next) {
		if (value->type != R_JSON_INTEGER || value->num.u_value > 255) { return false; }
		channels[i] = value->num.u_value / 255.f;
	}
	*color = r3_color (channels[0], channels[1], channels[2]);
	return true;
}

bool app_next_theme(App *a) {
	// A demo still uses r2's installed themes, without opening a binary.
	if (!a->backend.core && !a->backend.endpoint && a->demo) {
		a->backend.core = r_core_new ();
		if (a->backend.core) {
			r_config_set_i (a->backend.core->config, "scr.color", 3);
			r_config_set_b (a->backend.core->config, "scr.interactive", false);
			r_config_set_b (a->backend.core->config, "scr.utf8", false);
			r_config_set_i (a->backend.core->config, "scr.maxpage", 0);
		}
	}
	if (a->backend.core) {
		// Persist theme changes outside the temporary command capture context.
		if (r_core_cmd0 (a->backend.core, "ecn") < 0) { return false; }
		r_cons_pal_reload (a->backend.core->cons);
	} else {
		char *result = backend_command (&a->backend, "ecn");
		if (!result) { snprintf (a->message, sizeof (a->message), "Cannot change r2 theme: %.190s", a->backend.error); return false; }
		free (result);
	}
	RJson *palette = backend_json (&a->backend, "ecj");
	char *name = backend_command (&a->backend, "eco.");
	if (!palette || palette->type != R_JSON_OBJECT) {
		r_json_free (palette); free (name);
		snprintf (a->message, sizeof (a->message), "Cannot read r2 theme palette");
		return false;
	}
	const char *keys[] = {"flow2", "mov", "graph.true", "push", "graph.false", "flag", "graph.true", "graph.false"};
	for (size_t i = 0; i < R_ARRAY_SIZE (keys); i++) {
		a->palette[i] = neon[i];
		palette_entry (palette, keys[i], &a->palette[i]);
	}
	a->themed = true;
	a->inspector_background = inspector_background (&a->backend);
	if (name) { r_str_ansi_strip (name); r_str_trim (name); }
	snprintf (a->theme, sizeof (a->theme), "%s", R_STR_ISNOTEMPTY (name)? name: "r2");
	int scroll = a->scroll;
	if (a->inspector_tab != 4) {
		char *previous = a->inspection;
		a->inspection = NULL;
		app_inspect (a);
		if (!a->inspection || !*r_str_trim_head_ro (a->inspection) || *a->backend.error) {
			free (a->inspection);
			a->inspection = previous;
		} else { free (previous); }
		a->scroll = 0;
		app_scroll (a, scroll);
	}
	a->terminal.repaint = true;
	snprintf (a->message, sizeof (a->message), "r2 theme: %s", a->theme);
	r_json_free (palette); free (name);
	return true;
}
