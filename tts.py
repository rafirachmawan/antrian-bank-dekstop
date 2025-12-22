# tts.py
import sys
import asyncio
import edge_tts
import os

VOICE = "id-ID-GadisNeural"  # ✅ cewek Indonesia

async def main():
    # argv: python tts.py "text..." "output.mp3"
    text = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
    output = (sys.argv[2] if len(sys.argv) > 2 else "tts.mp3").strip()

    if not text:
        print("ERROR: teks kosong")
        return

    communicate = edge_tts.Communicate(text, VOICE)
    await communicate.save(output)

    print("OK:", os.path.abspath(output))

if __name__ == "__main__":
    asyncio.run(main())
