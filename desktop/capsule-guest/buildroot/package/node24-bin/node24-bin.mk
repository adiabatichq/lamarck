################################################################################
#
# node24-bin
#
################################################################################

NODE24_BIN_VERSION = 24.10.0
NODE24_BIN_SOURCE = node-v$(NODE24_BIN_VERSION)-linux-arm64.tar.xz
NODE24_BIN_SITE = https://nodejs.org/dist/v$(NODE24_BIN_VERSION)
NODE24_BIN_LICENSE = MIT
NODE24_BIN_LICENSE_FILES = LICENSE

define NODE24_BIN_INSTALL_TARGET_CMDS
	mkdir -p $(TARGET_DIR)/usr/local
	cp -a $(@D)/bin $(@D)/include $(@D)/lib $(@D)/share $(TARGET_DIR)/usr/local/
	install -D -m 0644 $(@D)/LICENSE $(TARGET_DIR)/usr/share/licenses/node24/LICENSE
endef

$(eval $(generic-package))
