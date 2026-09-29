package com.dhegeniusmedia.sms;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.*;

public class ConversationsActivity extends Activity {
    private LinearLayout list;
    private EditText search;
    private JSONArray data=new JSONArray();

    @Override public void onCreate(Bundle b){
        super.onCreate(b);
        LinearLayout root=new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(20,24,20,20);

        TextView title=new TextView(this);
        title.setText("DGM Unified Conversations");
        title.setTextSize(25);
        title.setTypeface(null,Typeface.BOLD);
        root.addView(title);

        search=new EditText(this);
        search.setHint("Search contact, number or message");
        root.addView(search);

        ScrollView scroll=new ScrollView(this);
        list=new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(list);
        root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));

        search.addTextChangedListener(new android.text.TextWatcher(){
            public void beforeTextChanged(CharSequence s,int st,int c,int a){}
            public void onTextChanged(CharSequence s,int st,int before,int count){render();}
            public void afterTextChanged(android.text.Editable e){}
        });

        setContentView(root);
        load();
    }

    private void load(){
        data=SyncStore.conversations(this);
        render();
    }

    private void render(){
        list.removeAllViews();

        Map<String,List<JSONObject>> groups=new LinkedHashMap<>();
        String q=search==null?"":search.getText().toString().trim().toLowerCase(Locale.US);

        for(int i=0;i<data.length();i++){
            JSONObject o=data.optJSONObject(i);
            if(o==null)continue;

            String sender=o.optString("sender","Unknown");
            String body=o.optString("body","");
            if(!q.isEmpty()&&!((sender+" "+body).toLowerCase(Locale.US).contains(q)))continue;

            String key=sender.trim().isEmpty()?"Unknown":sender;
            if(!groups.containsKey(key))groups.put(key,new ArrayList<JSONObject>());
            groups.get(key).add(o);
        }

        if(groups.isEmpty()){
            TextView empty=new TextView(this);
            empty.setText("\nNo matching conversation events.");
            empty.setTextSize(16);
            list.addView(empty);
            return;
        }

        for(Map.Entry<String,List<JSONObject>> e:groups.entrySet()){
            TextView head=new TextView(this);
            head.setText("\n"+e.getKey()+"  ("+e.getValue().size()+")");
            head.setTextSize(19);
            head.setTypeface(null,Typeface.BOLD);
            list.addView(head);

            List<JSONObject> rows=e.getValue();
            Collections.sort(rows,(a,b)->Long.compare(a.optLong("created_at",0),b.optLong("created_at",0)));

            for(JSONObject o:rows){
                addMessageRow(o);
            }
        }
    }

    private void addMessageRow(JSONObject o){
        String type=o.optString("type","sms");
        String label="whatsapp".equals(type)?"WhatsApp":"SMS";

        String direction=o.optString("direction","").trim().toLowerCase(Locale.US);
        boolean sent="outbound".equals(direction)
                ||"sent".equals(direction)
                ||"device".equals(direction)
                ||"device_sent".equals(direction);

        String directionLabel=sent?"Sent":"Received";

        // Sent/device messages are always on the RIGHT.
        // Received messages are always on the LEFT.
        LinearLayout row=new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(sent?Gravity.RIGHT:Gravity.LEFT);
        row.setPadding(0,4,0,4);

        LinearLayout bubble=new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(18,12,18,12);
        bubble.setGravity(sent?Gravity.RIGHT:Gravity.LEFT);

        GradientDrawable bubbleBg=new GradientDrawable();
        bubbleBg.setColor(Color.WHITE);
        bubbleBg.setCornerRadius(28f);
        bubble.setBackground(bubbleBg);

        TextView meta=new TextView(this);
        meta.setText(label+" • "+directionLabel);
        meta.setTextSize(12);
        meta.setTypeface(null,Typeface.BOLD);
        meta.setGravity(sent?Gravity.RIGHT:Gravity.LEFT);

        TextView body=new TextView(this);
        body.setText(o.optString("body",""));
        body.setTextSize(16);
        body.setGravity(sent?Gravity.RIGHT:Gravity.LEFT);

        TextView time=new TextView(this);
        time.setText(o.optString("time",o.optString("received_at","")));
        time.setTextSize(11);
        time.setGravity(sent?Gravity.RIGHT:Gravity.LEFT);

        bubble.addView(meta);
        bubble.addView(body);
        bubble.addView(time);

        int maxWidth=(int)(getResources().getDisplayMetrics().widthPixels*0.78f);
        LinearLayout.LayoutParams bp=new LinearLayout.LayoutParams(maxWidth,-2);
        bp.setMargins(sent?80:8,6,sent?8:80,6);

        LinearLayout.LayoutParams rp=new LinearLayout.LayoutParams(-1,-2);
        rp.setMargins(0,2,0,2);
        row.addView(bubble,bp);
        list.addView(row,rp);
    }
}
