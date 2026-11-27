.PHONY: all distdmg notary-setup notary-profiles

all run distdmg notary-setup notary-profiles:
	$(MAKE) -C app/mac $@
