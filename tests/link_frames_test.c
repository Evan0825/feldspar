#include "link_frames.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    link_frame_t frame={0};
    const char *topic="snoozmate/v1/devices/test/commands/down";
    const char *json="{\"command_id\":\"test\"}";
    int size=(int)strlen(json), topic_len=(int)strlen(topic);
    assert(link_frame_push(&frame,topic,topic,topic_len,json,5,size,0,false)==LF_MORE);
    assert(link_frame_push(&frame,topic,NULL,0,json+5,size-5,size,5,false)==LF_COMPLETE);
    assert(!strcmp(frame.data,json));
    assert(link_frame_push(&frame,topic,topic,topic_len,json,size,size,0,true)==LF_REJECTED);
    assert(link_frame_push(&frame,topic,"other",5,json,size,size,0,false)==LF_REJECTED);
    assert(link_frame_push(&frame,topic,topic,topic_len,json,5,size,0,false)==LF_MORE);
    assert(link_frame_push(&frame,topic,NULL,0,json+4,size-4,size,4,false)==LF_REJECTED);
    assert(link_frame_push(&frame,topic,topic,topic_len,json,size,1025,0,false)==LF_REJECTED);
    assert(link_frame_push(&frame,topic,topic,topic_len,"\0",1,1,0,false)==LF_REJECTED);
    assert(link_frame_push(&frame,topic,topic,topic_len,json,size,size,-1,false)==LF_REJECTED);
    assert(link_frame_push(&frame,topic,topic,topic_len,json,size,size,0,false)==LF_COMPLETE);
    puts("MQTT command fragmentation, topic and retained-message checks passed (host only).");
}
