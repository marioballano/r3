.PHONY: all distdmg notary-setup notary-profiles

all distdmg notary-setup notary-profiles:
	$(MAKE) -C app/mac $@
