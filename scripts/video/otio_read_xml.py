"""2º leitor do XML da montagem (#13372): o adapter FCP7 (`fcp_xml`) do
OpenTimelineIO lê o XML que o `build` gerou e devolve, em JSON no stdout, as
sequências com as faixas e os clipes (tempo na sequência e na mídia, em
quadros). O `verify-xml` compara isso com o que o leitor próprio dele leu
(`scripts/lib/diaria/video-xml-otio.ts`).

Dependência OPCIONAL, fora do venv da montagem: `pip install -r
scripts/video/otio-requirements.txt` no Python apontado por
DIARIA_OTIO_PYTHON (ou no próprio venv da montagem). Sem o OpenTimelineIO
instalado, sai com código 3 e `{"ok": false, "missingModule": true}`; o
verify-xml avisa e segue.

Uso: python -P otio_read_xml.py ARQUIVO.xml
"""

import json
import sys


def fail(code, reason, missing=False):
    print(json.dumps({"ok": False, "reason": reason, "missingModule": missing}))
    sys.exit(code)


def frames(rt):
    return int(round(rt.to_frames()))


def main():
    if len(sys.argv) != 2:
        fail(2, "uso: otio_read_xml.py ARQUIVO.xml")
    try:
        import opentimelineio as otio
    except ImportError as e:
        fail(3, f"opentimelineio ausente neste Python ({e})", missing=True)
    try:
        result = otio.adapters.read_from_file(sys.argv[1], adapter_name="fcp_xml")
    except otio.exceptions.NotSupportedError as e:
        # OTIO 0.16+ tirou o fcp_xml do pacote: sem o otio-fcp-adapter, "adapter not supported: fcp_xml".
        fail(3, f"adapter fcp_xml ausente (pip install otio-fcp-adapter): {e}", missing=True)
    except Exception as e:  # XML que o adapter não entende
        fail(4, f"{type(e).__name__}: {e}")

    if isinstance(result, otio.schema.Timeline):
        timelines = [result]
    else:
        timelines = list(result.find_children(descended_from_type=otio.schema.Timeline))

    out = []
    for tl in timelines:
        tracks = []
        for tr in tl.tracks:
            items = []
            for it in tr:
                rng = tr.range_of_child(it)
                entry = {"recStart": frames(rng.start_time), "recEnd": frames(rng.end_time_exclusive())}
                if isinstance(it, otio.schema.Clip):
                    sr = it.source_range or it.available_range()
                    entry.update({
                        "type": "clip",
                        "name": it.name,
                        "srcStart": frames(sr.start_time),
                        "srcEnd": frames(sr.end_time_exclusive()),
                        "url": getattr(it.media_reference, "target_url", None),
                    })
                elif isinstance(it, otio.schema.Gap):
                    entry["type"] = "gap"
                else:
                    entry["type"] = type(it).__name__
                items.append(entry)
            tracks.append({"kind": str(tr.kind), "name": tr.name, "items": items})
        dur = tl.duration()
        out.append({"name": tl.name, "durationFrames": frames(dur), "rate": dur.rate, "tracks": tracks})
    print(json.dumps({"ok": True, "version": otio.__version__, "timelines": out}))


if __name__ == "__main__":
    main()
