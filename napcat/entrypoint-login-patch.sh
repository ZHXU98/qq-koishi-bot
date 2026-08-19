#!/bin/bash
# NapCat 登录流程补丁（2026-08-19 固化）
#
# 背景：NapCat 原生逻辑中，一旦配置了 NAPCAT_QUICK_PASSWORD，密码回退「失败/需验证码」时
#       不会自动进入二维码扫码（napcat.mjs 条件 `!l && !d && !t.isLogined` 中
#       !d = 未尝试过密码才出二维码），导致「票据失效 + 密码失败」时卡死在登录失败态，
#       只能靠掉线监控反复 restart 空转，无限折腾。
#
# 补丁效果：密码回退（原生只尝试一次）失败后，同样立即刷新二维码进入扫码等待态 →
#           monitor/check_napcat.sh 检测到 /app/napcat/cache/qrcode.png 后导出
#           monitor/latest_qr.png 并通知 → 用户找 WorkBuddy 扫码登录。
#
# 注意：napcat.mjs 是镜像启动时由原 entrypoint 从 NapCat.Shell.zip 解压生成，
#       wrapper 先于原 entrypoint 运行，因此需自备同样的一次性解压逻辑，
#       否则 patch 时文件尚不存在。原 entrypoint 检测到文件已存在会自动跳过解压。
#
# 幂等：已打补丁（含 WB_PATCH_QUICK_LOGIN_QR 标记）则跳过；
#       容器重建（docker compose up -d 重新创建 / 镜像更新）后 napcat.mjs 恢复原样，
#       本 wrapper 每次启动都会再次生效。
set +e
cd /app || exit 1
if [ ! -f "napcat/napcat.mjs" ]; then
    unzip -q NapCat.Shell.zip -d ./NapCat.Shell
    cp -rf NapCat.Shell/* napcat/
    rm -rf ./NapCat.Shell
fi
MJS="/app/napcat/napcat.mjs"
if [ -f "$MJS" ] && ! grep -q "WB_PATCH_QUICK_LOGIN_QR" "$MJS"; then
  # 三处「密码回退失败/需验证码后不出二维码」的条件：去掉 !d / !u / !c（attempted 判断），
  # 密码回退失败同样进入二维码扫码；并追加标记防止重复 patch。
  sed -i \
    -e 's/!l && !d && !t.isLogined && n.getQRCodePicture();/!l \&\& !t.isLogined \&\& n.getQRCodePicture(); \/\/ WB_PATCH_QUICK_LOGIN_QR/g' \
    -e 's/!c && !u && !t.isLogined && n.getQRCodePicture();/!c \&\& !t.isLogined \&\& n.getQRCodePicture(); \/\/ WB_PATCH_QUICK_LOGIN_QR/g' \
    -e 's/!a && !c && !t.isLogined && n.getQRCodePicture();/!a \&\& !t.isLogined \&\& n.getQRCodePicture(); \/\/ WB_PATCH_QUICK_LOGIN_QR/g' \
    "$MJS"
  echo "[login-patch] napcat.mjs 已打补丁（3 处）：密码回退失败后进入二维码扫码"
else
  echo "[login-patch] 补丁已存在或文件缺失，跳过"
fi
exec bash /app/entrypoint.sh "$@"
