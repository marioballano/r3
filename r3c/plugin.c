#include "r3c.h"
#include <r_lib.h>

static RCmdResult r3c_command(RCmdContext *ctx) {
	RCorePluginSession *session = ctx->handler_user;
	if (r_strs_len (ctx->subcmd) == 1 && r_cmdctx_help (ctx)) {
		const char *argv[] = { "r3c", "-h" };
		return (RCmdResult) { .status = r3c_run (2, argv, session->core, ctx->cons) };
	}
	if (!r_strs_empty (ctx->subcmd)) {
		return (RCmdResult) { .action = R_CMD_ACTION_UNHANDLED };
	}
	size_t argc = r_cmdctx_argc (ctx) + 1;
	const char **argv = calloc (argc + 1, sizeof (*argv));
	if (!argv) {
		return (RCmdResult) { .status = 1 };
	}
	argv[0] = "r3c";
	r_cmdctx_args (ctx, argv + 1, argc - 1);
	int status = r3c_run ((int)argc, argv, session->core, ctx->cons);
	free (argv);
	return (RCmdResult) { .status = status };
}

RCorePlugin r_core_plugin_r3c = {
	.meta = {
		.name = "r3c",
		.desc = "Terminal city, call graph and control-flow views",
	},
	.command = "r3c",
	.call_ctx = r3c_command,
};

R_API RLibStruct radare_plugin = {
	.type = R_LIB_TYPE_CORE,
	.data = &r_core_plugin_r3c,
	.version = R2_VERSION,
	.abiversion = R2_ABIVERSION,
};
