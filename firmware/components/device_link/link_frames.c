#include "link_frames.h"
#include <string.h>

lf_result_t link_frame_push(link_frame_t *f, const char *expected,
    const char *topic, int topic_len, const char *data, int length, int total, int offset, bool retained) {
    if (retained || !expected || !data || length<=0 || total<=0 || total>LINK_COMMAND_MAX ||
        offset<0 || length>total || offset>total-length || topic_len<0) goto rejected;
    if (topic_len && (!topic || (size_t)topic_len!=strlen(expected) || memcmp(topic,expected,(size_t)topic_len))) goto rejected;
    if (!offset) {
        if (!topic_len) goto rejected;
        f->used=0; f->total=(size_t)total;
    }
    if ((size_t)offset!=f->used || f->total!=(size_t)total || memchr(data,0,(size_t)length)) goto rejected;
    memcpy(f->data+f->used,data,(size_t)length);
    f->used+=(size_t)length;
    f->data[f->used]=0;
    return f->used==f->total ? LF_COMPLETE : LF_MORE;
rejected:
    f->used=f->total=0;
    return LF_REJECTED;
}
