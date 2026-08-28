<?php

/**
 * 滑动验证码核心逻辑（PHP / GD 版）
 * 移植自 captcha-worker 的 src/slide.js，逻辑与字段保持一致：
 *  - generate：随机缺口位置 + UUID v4 + 一次性存储，返回背景 PNG / 拼图 PNG（data URL）
 *  - verify：uuid 一次性消费 + 位置容差 5px + 轨迹硬性拦截 + 行为评分
 *
 * 与 JS 版的差异：
 *  - 绘制用 GD（imagecreatetruecolor 等），替代 resvg-wasm 渲染 SVG
 *  - 存储用文件模拟 KV（php/slide_data/ 下按 uuid 存 JSON，TTL 过期自动清理）
 *
 * 依赖：PHP 7.4+，扩展 gd（php -m | grep gd）
 */

declare(strict_types=1);

class SlideCaptcha
{
    public const PUZZLE_SIZE = 40;   // 拼图块尺寸（与前端保持一致）
    public const BG_W = 300;         // 画布宽
    public const BG_H = 150;         // 画布高
    public const TTL_S = 300;        // uuid 有效期（秒），对应 JS 版 5 分钟
    public const TOLERANCE = 5;      // 滑块终点允许偏差（px）
    public const PASS_SCORE = 60;    // 通过分数线

    private string $storeDir;

    public function __construct(string $storeDir = __DIR__ . '/slide_data')
    {
        if (!extension_loaded('gd')) {
            throw new RuntimeException('需要启用 GD 扩展（php -m | grep gd）');
        }
        $this->storeDir = $storeDir;
        if (!is_dir($storeDir)) {
            mkdir($storeDir, 0777, true);
        }
    }

    // ============================================================
    // 存储（文件模拟 KV：跨请求共享 + TTL 过期 + 一次性消费）
    // ============================================================

    private function kvPut(string $key, array $value): void
    {
        $value['exp'] = time() * 1000 + self::TTL_S * 1000;
        file_put_contents($this->storeDir . '/' . $key . '.json', json_encode($value));
    }

    private function kvGet(string $key): ?array
    {
        $file = $this->storeDir . '/' . $key . '.json';
        if (!is_file($file)) {
            return null;
        }
        $data = json_decode((string) file_get_contents($file), true);
        if (!is_array($data)) {
            return null;
        }
        if (($data['exp'] ?? 0) < time() * 1000) {
            @unlink($file);
            return null;
        }
        return $data;
    }

    private function kvDelete(string $key): void
    {
        @unlink($this->storeDir . '/' . $key . '.json');
    }

    // ============================================================
    // 工具函数
    // ============================================================

    /** UUID v4（8-4-4-4-12） */
    private function randomUuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        $hex = bin2hex($bytes);
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4)
            . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
    }

    /** HSL → RGB（h: 0~359, s/l: 0~1） */
    private static function hslToRgb(float $h, float $s, float $l): array
    {
        $c = (1 - abs(2 * $l - 1)) * $s;
        $x = $c * (1 - abs(fmod($h / 60.0, 2) - 1));
        $m = $l - $c / 2;
        if ($h < 60)       [$r, $g, $b] = [$c, $x, 0];
        elseif ($h < 120)  [$r, $g, $b] = [$x, $c, 0];
        elseif ($h < 180)  [$r, $g, $b] = [0, $c, $x];
        elseif ($h < 240)  [$r, $g, $b] = [0, $x, $c];
        elseif ($h < 300)  [$r, $g, $b] = [$x, 0, $c];
        else               [$r, $g, $b] = [$c, 0, $x];
        return [
            (int) round(($r + $m) * 255),
            (int) round(($g + $m) * 255),
            (int) round(($b + $m) * 255),
        ];
    }

    /** GD 图像 → PNG data URL（并释放图像资源） */
    private function toPngDataUrl($img): string
    {
        ob_start();
        imagepng($img);
        $bin = (string) ob_get_clean();
        imagedestroy($img);
        return 'data:image/png;base64,' . base64_encode($bin);
    }

    // ============================================================
    // 绘制
    // ============================================================

    /** 生成随机形状集合（背景与拼图块共用，保证缺口区域内容一致） */
    private function buildShapes(): array
    {
        $circles = [];
        for ($i = 0; $i < 50; $i++) {
            $circles[] = [
                mt_rand(0, self::BG_W * 10) / 10,          // cx
                mt_rand(0, self::BG_H * 10) / 10,          // cy
                mt_rand(40, 160) / 10,                     // r（4.0~16.0）
                mt_rand(0, 359),                           // hue
                mt_rand(15, 40) / 100,                     // alpha（0.15~0.40）
            ];
        }
        $lines = [];
        for ($i = 0; $i < 14; $i++) {
            $lines[] = [
                mt_rand(0, self::BG_W * 10) / 10,
                mt_rand(0, self::BG_H * 10) / 10,
                mt_rand(0, self::BG_W * 10) / 10,
                mt_rand(0, self::BG_H * 10) / 10,
                mt_rand(10, 30) / 100,                     // alpha（0.10~0.30）
                mt_rand(10, 30) / 10,                      // 线宽（1.0~3.0）
            ];
        }
        return ['circles' => $circles, 'lines' => $lines];
    }

    /** 画渐变底 + 随机形状（对应 SVG 的 bg-grad / pz-grad + shapes） */
    private function drawBase($img, array $shapes, int $hue1, int $hue2): void
    {
        // 对角渐变（对应 SVG linearGradient x1=0 y1=0 x2=1 y2=1），
        // 预计算 256 级 RGB 插值查找表，避免逐像素 imagecolorallocate 爆炸
        [$r1, $g1, $b1] = self::hslToRgb((float) $hue1, 0.62, 0.72);
        [$r2, $g2, $b2] = self::hslToRgb((float) $hue2, 0.55, 0.58);
        $palette = [];
        for ($i = 0; $i <= 255; $i++) {
            $t = $i / 255;
            $palette[$i] = imagecolorallocate(
                $img,
                (int) round($r1 + ($r2 - $r1) * $t),
                (int) round($g1 + ($g2 - $g1) * $t),
                (int) round($b1 + ($b2 - $b1) * $t)
            );
        }
        for ($y = 0; $y < self::BG_H; $y++) {
            for ($x = 0; $x < self::BG_W; $x++) {
                $t = (int) round(($x / self::BG_W + $y / self::BG_H) / 2 * 255);
                imagesetpixel($img, $x, $y, $palette[$t]);
            }
        }

        // 随机圆（半透明 hsla）
        foreach ($shapes['circles'] as [$cx, $cy, $rad, $h, $a]) {
            [$r, $g, $b] = self::hslToRgb((float) $h, 0.70, 0.85);
            $col = imagecolorallocatealpha($img, $r, $g, $b, (int) round((1 - $a) * 127));
            imagefilledellipse($img, (int) $cx, (int) $cy, (int) ($rad * 2), (int) ($rad * 2), $col);
        }

        // 随机线段（半透明白）
        foreach ($shapes['lines'] as [$x1, $y1, $x2, $y2, $a, $w]) {
            imagesetthickness($img, (int) $w);
            $col = imagecolorallocatealpha($img, 255, 255, 255, (int) round((1 - $a) * 127));
            imageline($img, (int) $x1, (int) $y1, (int) $x2, (int) $y2, $col);
        }
        imagesetthickness($img, 1);
    }

    /** 缺口遮罩：半透明黑圆角矩形（视觉上的"洞"，对应 SVG 的遮罩 rect） */
    private function drawHole($bg, int $tx, int $ty): void
    {
        $r = 4;
        $s = self::PUZZLE_SIZE;
        $mask = imagecolorallocatealpha($bg, 0, 0, 0, 64); // 约 0.5 不透明度
        // 主体（避开四角）
        imagefilledrectangle($bg, $tx, $ty + $r, $tx + $s, $ty + $s - $r, $mask);
        imagefilledrectangle($bg, $tx + $r, $ty, $tx + $s - $r, $ty + $s, $mask);
        // 四角用圆填充形成圆角
        imagefilledellipse($bg, $tx + $r, $ty + $r, $r * 2, $r * 2, $mask);
        imagefilledellipse($bg, $tx + $s - $r, $ty + $r, $r * 2, $r * 2, $mask);
        imagefilledellipse($bg, $tx + $r, $ty + $s - $r, $r * 2, $r * 2, $mask);
        imagefilledellipse($bg, $tx + $s - $r, $ty + $s - $r, $r * 2, $r * 2, $mask);
    }

    /** 拼图块：从 base 抠出缺口区域 + 四角圆角裁为透明 */
    private function buildPuzzle($base, int $tx, int $ty)
    {
        $s = self::PUZZLE_SIZE;
        $r = 4;
        $pz = imagecreatetruecolor($s, $s);
        // 透明底
        imagealphablending($pz, false);
        imagefill($pz, 0, 0, imagecolorallocatealpha($pz, 0, 0, 0, 127));
        // 拷贝缺口区域（图案与背景严格一致）
        imagecopy($pz, $base, 0, 0, $tx, $ty, $s, $s);
        // 圆角外置透明（精确写 alpha，需要关闭 blending）
        imagealphablending($pz, false);
        for ($y = 0; $y < $s; $y++) {
            for ($x = 0; $x < $s; $x++) {
                $inCorner = false;
                if ($x < $r && $y < $r) {
                    $inCorner = true;
                } elseif ($x >= $s - $r && $y < $r) {
                    $inCorner = true;
                } elseif ($x < $r && $y >= $s - $r) {
                    $inCorner = true;
                } elseif ($x >= $s - $r && $y >= $s - $r) {
                    $inCorner = true;
                }
                if (!$inCorner) {
                    continue;
                }
                $cx = $x < $r ? $r : $s - 1 - $r;
                $cy = $y < $r ? $r : $s - 1 - $r;
                $d2 = ($x - $cx) ** 2 + ($y - $cy) ** 2;
                if ($d2 > $r * $r) {
                    imagesetpixel($pz, $x, $y, imagecolorallocatealpha($pz, 0, 0, 0, 127));
                }
            }
        }
        return $pz;
    }

    // ============================================================
    // 对外接口
    // ============================================================

    /** 生成验证码：返回 uuid + 背景 PNG + 拼图 PNG（targetX 仅供服务端校验） */
    public function generate(): array
    {
        // 缺口位置：水平集中在中间偏右（100~200px），垂直随机并留出安全边距
        $targetX = random_int(100, 200);
        $targetY = random_int(10, self::BG_H - self::PUZZLE_SIZE - 20);

        $uuid = $this->randomUuid();
        $this->kvPut($uuid, ['targetX' => $targetX, 'targetY' => $targetY]);

        $hue1 = mt_rand(0, 359);
        $hue2 = ($hue1 + 40 + mt_rand(0, 79)) % 360;
        $shapes = $this->buildShapes();

        // 先画"纯背景"（渐变 + 形状，无遮罩），背景图与拼图块都从它派生
        $base = imagecreatetruecolor(self::BG_W, self::BG_H);
        $this->drawBase($base, $shapes, $hue1, $hue2);

        // 背景 = base + 缺口遮罩
        $bg = imagecreatetruecolor(self::BG_W, self::BG_H);
        imagecopy($bg, $base, 0, 0, 0, 0, self::BG_W, self::BG_H);
        $this->drawHole($bg, $targetX, $targetY);

        // 拼图块 = base 的缺口区域 + 圆角透明
        $puzzle = $this->buildPuzzle($base, $targetX, $targetY);

        return [
            'uuid' => $uuid,
            // 'targetX' => $targetX, // 仅供服务端校验，路由层不要下发给客户端
            // 'targetY' => $targetY,
            'background' => $this->toPngDataUrl($bg),
            'puzzle' => $this->toPngDataUrl($puzzle),
            'width' => self::BG_W,
            'height' => self::BG_H,
            'puzzleSize' => self::PUZZLE_SIZE,
            'puzzleY' => $targetY,
            'expiresIn' => self::TTL_S * 1000,
        ];
    }

    /** 校验：uuid 一次性 + 位置容差 + 轨迹硬性拦截 + 行为评分（公式与 JS 版一致） */
    public function verify(array $body): array
    {
        $uuid = $body['uuid'] ?? null;
        $x = $body['x'] ?? 0;
        $track = $body['track'] ?? null;
        $duration = $body['duration'] ?? 0;

        // ---- 1. uuid 校验（一次性 + 未过期） ----
        if (!$uuid) {
            return ['success' => false, 'message' => '验证码已失效，请重试'];
        }
        $rec = $this->kvGet($uuid);
        if ($rec === null) {
            return ['success' => false, 'message' => '验证码已失效，请重试'];
        }
        $this->kvDelete($uuid); // 一次性：无论成败都消费掉，防重放

        // ---- 2. 位置校验（位置为王：容差 5px，不向客户端暴露偏差值） ----
        $diff = abs((float) $x - $rec['targetX']);
        if ($diff > self::TOLERANCE) {
            return ['success' => false, 'message' => '滑块位置未对准，请重试'];
        }

        // ---- 3. 硬性拦截（绝对规则，大概率是脚本） ----
        if (!is_array($track) || count($track) < 10) {
            return ['success' => false, 'message' => '轨迹点数太少，疑似脚本注入'];
        }
        if ($duration < 300) {
            return ['success' => false, 'message' => '拖动时间极短，疑似直接注入坐标'];
        }
        if ($duration > 10000) {
            return ['success' => false, 'message' => '验证码超时'];
        }
        // 轨迹应从滑块起点附近开始（防"只提交终点坐标"）
        if (abs($track[0]['x'] ?? 0) > 10) {
            return ['success' => false, 'message' => '轨迹起点异常，请从滑块处开始拖动'];
        }

        // ---- 4. 行为评分（低误杀策略：位置命中给基础分，特征有则加分、无则给基础分） ----
        $score = 40;

        // 4.1 Y 轴抖动
        $ys = array_map(fn($p) => (float) ($p['y'] ?? 0), $track);
        $meanY = array_sum($ys) / count($ys);
        $yStd = sqrt(array_sum(array_map(fn($v) => ($v - $meanY) ** 2, $ys)) / count($ys));
        $score += $yStd > 1.5 ? 10 : 5;

        // 4.2 速度波动
        $vel = [];
        for ($i = 1; $i < count($track); $i++) {
            $dt = ($track[$i]['t'] ?? 0) - ($track[$i - 1]['t'] ?? 0);
            $dx = abs(($track[$i]['x'] ?? 0) - ($track[$i - 1]['x'] ?? 0));
            if ($dt > 0) {
                $vel[] = $dx / $dt;
            }
        }
        $meanV = $vel ? array_sum($vel) / count($vel) : 0;
        $vStd = $vel ? sqrt(array_sum(array_map(fn($v) => ($v - $meanV) ** 2, $vel)) / count($vel)) : 0;
        $score += $vStd > 2 ? 10 : 5;

        // 4.3 终点微调（最后几个采样点几乎不动，符合真人松手前微调习惯）
        $xs = array_map(fn($p) => (float) ($p['x'] ?? 0), $track);
        $last5 = array_slice($xs, -5);
        $diffLast5 = count($last5) ? end($last5) - reset($last5) : 0;
        if (abs($diffLast5) < 5) {
            $score += 10;
        }

        // 4.4 停顿（真人拖动中常伴随 100ms 以上停顿）
        $pauses = 0;
        for ($i = 1; $i < count($track); $i++) {
            if (($track[$i]['t'] ?? 0) - ($track[$i - 1]['t'] ?? 0) > 100) {
                $pauses++;
            }
        }
        $score += $pauses >= 2 ? 10 : 5;

        // 4.5 合理耗时区间
        $score += ($duration >= 500 && $duration <= 5000) ? 10 : 5;

        // 4.6 防高级机器人：极度平稳的匀速直线（无抖、无波动、无停顿、无微调）
        if ($yStd < 0.1 && $vStd < 0.1 && $pauses === 0 && abs($diffLast5) < 2) {
            $score -= 30;
        }

        $pass = $score >= self::PASS_SCORE;
        return [
            'success' => $pass,
            'score' => $score,
            'message' => $pass ? '验证成功' : '行为轨迹评分过低（' . $score . '/' . self::PASS_SCORE . '）',
        ];
    }
}
