#!/usr/bin/env python3
from __future__ import annotations
"""Pure helpers for piecewise TTS; --self-test runs offline and needs no API credentials."""
import re
import sys
from typing import Iterable, Mapping, Sequence

_CLEAN_RE = re.compile(r'[^\w\u4e00-\u9fff]')
_PUNCTUATION = set("，。！？：；、,.!?;:")


def clean(text: str) -> str:
    return _CLEAN_RE.sub("", text)


def split_golden_prefix(text: str, base_rate: int, fast_rate: int,
                        target_seconds: float = 3.0,
                        chars_per_second: float = 6.0) -> tuple[str, str]:
    """Split a lossless text prefix estimated to occupy the fast opening segment."""
    if not -50 <= base_rate <= 100 or not -50 <= fast_rate <= 100:
        raise ValueError("speech_rate must be within [-50, 100]")
    if fast_rate <= base_rate:
        raise ValueError("golden-3s speech rate must be greater than the normal rate")
    if target_seconds <= 0 or chars_per_second <= 0:
        raise ValueError("target_seconds and chars_per_second must be positive")
    if not text:
        return "", ""

    total_clean = len(clean(text))
    # Provider values: -50 is 0.5x, 0 is 1x, and 100 is 2x.
    target_chars = max(1, round(target_seconds * chars_per_second *
                                (100 + fast_rate) / (100 + base_rate)))
    if total_clean <= target_chars:
        return text, ""

    chars = list(text)
    boundaries = []
    for index, char in enumerate(chars, start=1):
        if char in _PUNCTUATION:
            count = len(clean("".join(chars[:index])))
            if target_chars * 0.6 <= count <= target_chars * 1.4:
                boundaries.append((abs(count - target_chars), count, index))

    if boundaries:
        _, _, split_index = min(boundaries)
    else:
        count = 0
        split_index = 0
        for index, char in enumerate(chars, start=1):
            count += len(clean(char))
            if count >= target_chars:
                split_index = index
                break
        while split_index < len(chars) and chars[split_index] in _PUNCTUATION:
            split_index += 1

    prefix = "".join(chars[:split_index])
    suffix = "".join(chars[split_index:])
    if not prefix or not suffix:
        return text, ""
    if prefix + suffix != text:
        raise AssertionError("TTS segmentation must preserve the exact source text")
    return prefix, suffix


def normalize_word_times(words: Iterable[Mapping], duration_seconds: float) -> list[dict]:
    """Convert provider word timestamps to seconds; provider may return ms or sec."""
    items = [dict(word) for word in words]
    max_end = max((float(word.get("endTime", 0)) for word in items), default=0.0)
    scale = 1000.0 if duration_seconds > 0 and max_end > duration_seconds * 10 else 1.0
    result = []
    for word in items:
        if "startTime" in word:
            word["startTime"] = float(word["startTime"]) / scale
        if "endTime" in word:
            word["endTime"] = float(word["endTime"]) / scale
        result.append(word)
    return result


def captions_for(text: str, words: Sequence[Mapping], duration: float, plan=None) -> list[dict]:
    if plan is not None:
        if "".join(plan) != text:
            raise RuntimeError(
                f"字幕切分计划与口播原文不一致，无法对位时间轴：计划拼回「{''.join(plan)}」"
            )
        pieces = list(plan)
    else:
        pieces = []
        for clause in re.findall(r'[^，。！？：；、]+[，。！？：；、]?', text):
            if len(clause) <= 15:
                pieces.append(clause)
            else:
                part_count = -(-len(clause) // 15)
                size = -(-len(clause) // part_count)
                pieces.extend(clause[i:i + size] for i in range(0, len(clause), size))

    timeline = []
    for word in words:
        token = clean(str(word.get("word", "")))
        start = float(word.get("startTime", 0))
        end = float(word.get("endTime", start))
        for index, char in enumerate(token):
            timeline.append((
                char,
                start + (end - start) * index / max(1, len(token)),
                start + (end - start) * (index + 1) / max(1, len(token)),
            ))
    if "".join(item[0] for item in timeline) != clean(text):
        raise RuntimeError("Subtitle text mismatch; inspect saved word timestamps before proceeding")

    cursor = 0
    result = []
    for piece in pieces:
        count = len(clean(piece))
        if count:
            if cursor + count > len(timeline):
                raise RuntimeError("字幕切分超出了可用字级时间戳")
            result.append({
                "text": piece,
                "start": timeline[cursor][1],
                "end": timeline[cursor + count - 1][2],
            })
            cursor += count
    for index, caption in enumerate(result):
        caption["end"] = result[index + 1]["start"] if index + 1 < len(result) else duration
    if result:
        result[0]["start"] = 0.0
    return result


def self_test() -> int:
    checks = []
    text = "附近顾客明明不少，为什么进店的人还是很少？把优惠券发到客户群里，让老顾客愿意再来。"
    prefix, suffix = split_golden_prefix(text, 0, 30)
    checks.append(("分段保留原文", prefix + suffix == text and bool(suffix)))
    checks.append(("优先在自然标点处分段", bool(prefix) and prefix[-1] in _PUNCTUATION))
    normalized = normalize_word_times([
        {"word": "你", "startTime": 1000, "endTime": 1300},
        {"word": "好", "startTime": 1300, "endTime": 1600},
    ], 2.0)
    checks.append(("毫秒时间戳转秒", abs(normalized[0]["startTime"] - 1.0) < 1e-9 and abs(normalized[-1]["endTime"] - 1.6) < 1e-9))
    sec_words = [{"word": "你", "startTime": 0.0, "endTime": 0.3}]
    checks.append(("秒时间戳不重复缩放", normalize_word_times(sec_words, 1.0)[0]["endTime"] == 0.3))
    captions = captions_for("你好，世界", [
        {"word": "你", "startTime": 0.0, "endTime": 0.3},
        {"word": "好", "startTime": 0.3, "endTime": 0.6},
        {"word": "世", "startTime": 0.6, "endTime": 0.9},
        {"word": "界", "startTime": 0.9, "endTime": 1.2},
    ], 1.2, ["你好，", "世界"])
    checks.append(("拼接后字幕仍使用秒", len(captions) == 2 and captions[0]["end"] == 0.6 and captions[-1]["end"] == 1.2))
    try:
        captions_for("你好", sec_words, 1.0, ["你"])
        rejected = False
    except RuntimeError:
        rejected = True
    checks.append(("错误字幕计划会被拒绝", rejected))
    raw = "这是一段没有标点的中文文本" * 4
    p2, s2 = split_golden_prefix(raw, 0, 30)
    checks.append(("无标点回退分段保留原文", p2 + s2 == raw and bool(p2) and bool(s2)))
    failed = [name for name, passed in checks if not passed]
    for name, passed in checks:
        print(("PASS" if passed else "FAIL") + " · " + name)
    print(f"自检结果：{len(checks) - len(failed)}/{len(checks)}")
    return 1 if failed else 0


if __name__ == "__main__" and "--self-test" in sys.argv:
    raise SystemExit(self_test())
