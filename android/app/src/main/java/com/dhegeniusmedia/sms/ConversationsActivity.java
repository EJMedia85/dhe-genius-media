package com.dhegeniusmedia.sms;

import android.app.Activity;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
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
        LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(20,24,20,20);
        TextView title=new TextView(this); title.setText("DGM Unified Conversations"); title.setTextSize(25); root.addView(title);
        search=new EditText(this); search.setHint("Search contact, number or message"); root.addView(search);
        ScrollView scroll=new ScrollView(this); list=new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); scroll.addView(list); root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        search.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int st,int c,int a){} public void onTextChanged(CharSequence s,int st,int before,int count){render();} public void afterTextChanged(Editable e){}});
        setContentView(root); load();
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
            JSONObject o=data.optJSONObject(i); if(o==null)continue;
            String sender=o.optString("sender","Unknown");
            String body=o.optString("body","");
            if(!q.isEmpty()&&!((sender+" "+body).toLowerCase(Locale.US).contains(q)))continue;
            if(!groups.containsKey(sender))groups.put(sender,new ArrayList<JSONObject>());
            groups.get(sender).add(o);
        }
        if(groups.isEmpty()){
            TextView empty=new TextView(this); empty.setText("\nNo matching conversation events."); empty.setTextSize(16); list.addView(empty); return;
        }
        for(Map.Entry<String,List<JSONObject>> e:groups.entrySet()){
            TextView head=new TextView(this); head.setText("\n"+e.getKey()+"  ("+e.getValue().size()+")"); head.setTextSize(19); list.addView(head);
            List<JSONObject> rows=e.getValue();
            Collections.sort(rows,(a,b)->Long.compare(b.optLong("created_at",0),a.optLong("created_at",0)));
            for(JSONObject o:rows){
                String type=o.optString("type","sms");
                String label="whatsapp".equals(type)?"WhatsApp notification event":"SMS";
                String direction=o.optString("direction","").equals("outbound")?"Sent":"Received";
                TextView row=new TextView(this);
                row.setText((o.optBoolean("unread",false)?"● ":"")+label+" • "+direction+
                        "\n"+o.optString("body","")+
                        "\n"+o.optString("time",""));
                row.setTextSize(15); row.setPadding(14,14,14,18); list.addView(row);
            }
        }
    }
}
